import { db } from "../../helpers/db";
import Stripe from "stripe";
import { sql } from "kysely";
import { z, ZodError } from "zod";
import { requireCompanyStaff, ForbiddenCompanyAccessError } from "../../helpers/companyAccess";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession";
import { withTenantContext } from "../../helpers/tenant-context";
import { planPrices, type PlanId } from "../../helpers/rollmasterPricing";

const requestSchema = z.object({
  companyId: z.string().regex(/^[1-9][0-9]{0,18}$/),
}).strict();

const stripePriceEnv: Record<PlanId, string> = {
  basic: "STRIPE_TEST_PRICE_BASIC",
  basic_pro: "STRIPE_TEST_PRICE_BASIC_PRO",
  major: "STRIPE_TEST_PRICE_MAJOR",
  major_pro: "STRIPE_TEST_PRICE_MAJOR_PRO",
};

const responseHeaders = { "Cache-Control": "private, no-store" };

export async function handle(request: Request): Promise<Response> {
  try {
    const input = requestSchema.parse(await request.json());
    const { user, membership } = await requireCompanyStaff(request, input.companyId);
    if (membership.role !== "owner")
      throw new ForbiddenCompanyAccessError("Only company owners can subscribe");

    const env = process.env as Record<string, string | undefined>;
    const secretKey = env.STRIPE_TEST_SECRET_KEY;
    if (!secretKey?.startsWith("sk_test_"))
      return Response.json({ error: "Stripe test key not configured" }, { status: 503, headers: responseHeaders });

    // A configured, exact application origin is required. Never trust Host,
    // Origin or arbitrary success/cancel URLs supplied by the client.
    const appOrigin = env.ROLLMASTER_STAGING_ORIGIN;
    if (!appOrigin)
      return Response.json({ error: "Staging origin not configured" }, { status: 503, headers: responseHeaders });
    const url = new URL(appOrigin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      return Response.json({ error: "Invalid staging origin" }, { status: 503, headers: responseHeaders });

    const companyId = String(membership.companyId);
    // Serialize promotional eligibility checks against company mutations.
    // Monthly checkout must never grant the annual 40% promotion.
    const eligibility = await db.transaction().execute(async trx => {
      const company = await trx.selectFrom("companies")
        .select(["id", "hadTrialBefore", "trialUsed", "trialStatus", "isAnnualPromoApplied"])
        .where("id", "=", companyId).forUpdate().executeTakeFirst();
      if (!company) throw new ForbiddenCompanyAccessError("Company not found");
      const promoUsed = await trx.selectFrom("companies")
        .select("id").where("isAnnualPromoApplied", "=", true)
        .forUpdate().execute();
      return {
        mayTrial: company.hadTrialBefore === false && company.trialUsed === false,
        mayAnnualPromo: company.isAnnualPromoApplied === false && promoUsed.length < 100,
      };
    });
    const selection = await withTenantContext({
      companyId, userId: String(user.id), role: "owner",
    }, async (trx) => {
      const company = await trx.selectFrom("companies")
        .select(["id", "stripeSubscriptionId", "hadTrialBefore", "isAnnualPromoApplied"])
        .where("id", "=", companyId).forUpdate().executeTakeFirst();
      if (!company) throw new ForbiddenCompanyAccessError("Company not found");
      if (company.stripeSubscriptionId)
        return { error: "Company already has a linked Stripe subscription" } as const;
      const plan = await trx.selectFrom("companyPlanSelections")
        .select(["planId", "extraWorkers"])
        .where("companyId", "=", companyId).executeTakeFirst();
      if (!plan || !(plan.planId in planPrices))
        return { error: "Select a valid plan before checkout" } as const;
      const planKey = plan.planId as PlanId;
      if (!Number.isSafeInteger(plan.extraWorkers) || plan.extraWorkers < 0 ||
          plan.extraWorkers > planPrices[planKey].maxExtraWorkers)
        return { error: "Invalid worker seat selection" } as const;
      // Serialize promotional eligibility checks across tenants, not just this company.
      await sql`SELECT pg_advisory_xact_lock(741102, 100)`.execute(trx);
      const lockedCompanies = await trx.selectFrom("companies")
        .select(["id", "isAnnualPromoApplied"]).forUpdate().execute();
      const promoCount = lockedCompanies.filter(row => row.isAnnualPromoApplied === true).length;
      const promoEligible = company.isAnnualPromoApplied === true || promoCount < 100;
      const trialEligible = company.hadTrialBefore === false && eligibility.mayTrial;
      return { planKey, extraWorkers: plan.extraWorkers, promoEligible, trialEligible } as const;
    });

    if ("error" in selection)
      return Response.json({ error: selection.error }, { status: 409, headers: responseHeaders });

    const priceId = env[stripePriceEnv[selection.planKey]];
    if (!priceId?.startsWith("price_"))
      return Response.json({ error: "Stripe test price not configured" }, { status: 503, headers: responseHeaders });
    if (selection.extraWorkers !== 0)
      return Response.json({ error: "Extra worker Stripe prices not configured" }, { status: 409, headers: responseHeaders });

    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    // Never trust a client-supplied price, amount, plan or promotional status.
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active || price.type !== "recurring" || price.recurring?.interval !== "month" ||
        price.currency !== "eur" || price.unit_amount !== planPrices[selection.planKey].monthlyEur * 100)
      return Response.json({ error: "Stripe price configuration mismatch" }, { status: 503, headers: responseHeaders });

    // A 40% promotion is only granted when an actual Stripe coupon is configured.
    // Do not advertise a discount that checkout cannot honor.
    const promoCoupon = selection.promoEligible && eligibility.mayAnnualPromo ? env.STRIPE_PROMO_40_COUPON : undefined;
    const applyPromo = Boolean(promoCoupon?.startsWith("coupon_"));
    const metadata = { companyId, planKey: selection.planKey, isPromoApplied: String(applyPromo) };
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: companyId,
      metadata,
      subscription_data: { metadata, ...(selection.trialEligible ? { trial_period_days: 14 } : {}) },
      ...(applyPromo ? { discounts: [{ coupon: promoCoupon! }] } : {}),
      success_url: new URL("/billing/success?session_id={CHECKOUT_SESSION_ID}", url).toString(),
      cancel_url: new URL("/billing/cancel", url).toString(),
    });

    if (!session.id || !session.url)
      return Response.json({ error: "Stripe checkout did not return a URL" }, { status: 502, headers: responseHeaders });

    return Response.json({
      success: true,
      data: { sessionId: session.id, checkoutUrl: session.url },
    }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof NotAuthenticatedError)
      return Response.json({ error: "Authentication required" }, { status: 401, headers: responseHeaders });
    if (error instanceof ForbiddenCompanyAccessError)
      return Response.json({ error: "Access denied" }, { status: 403, headers: responseHeaders });
    if (error instanceof ZodError || error instanceof SyntaxError)
      return Response.json({ error: "Invalid request" }, { status: 400, headers: responseHeaders });
    console.error("Stripe test checkout creation failed", error);
    return Response.json({ error: "Checkout unavailable" }, { status: 502, headers: responseHeaders });
  }
}