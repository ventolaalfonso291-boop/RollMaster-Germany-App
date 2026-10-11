import Stripe from "stripe";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { db } from "../../helpers/db";
import { billingTransition, type BillingState } from "../../helpers/subscriptionLifecycle";

export const flootPublic = true;

type CheckoutSession = {
  id?: string;
  mode?: string;
  payment_status?: string;
  status?: string;
  subscription?: string | { id?: string } | null;
  metadata?: Record<string, string>;
};

function subscriptionId(value: CheckoutSession["subscription"]): string | null {
  const id = typeof value === "string" ? value : value?.id;
  return typeof id === "string" && /^sub_[A-Za-z0-9]+$/.test(id) ? id : null;
}

export async function handle(request: Request): Promise<Response> {
  const secret = (process.env as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "Webhook secret not configured" }, { status: 503 });
  const raw = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  const timestamp = signature.match(/(?:^|,)t=(\d+)/)?.[1];
  const signatures = [...signature.matchAll(/(?:^|,)v1=([a-f0-9]{64})/g)].map(m => m[1]);
  if (!timestamp || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signatures.length)
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  const expected = createHmac("sha256", secret).update(timestamp + "." + raw).digest();
  if (!signatures.some(s => timingSafeEqual(Buffer.from(s, "hex"), expected)))
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  let event: any;
  try { event = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof event.id !== "string" || typeof event.type !== "string" || event.id.length > 255)
    return Response.json({ error: "Invalid event" }, { status: 400 });

  const object = event.data?.object as CheckoutSession | undefined;
  const checkout = event.type === "checkout.session.completed";
  const action = event.type === "invoice.paid" || event.type === "invoice.payment_succeeded" ? "paid" :
    event.type === "invoice.payment_failed" ? "failed" : null;
  if (!checkout && !action) return Response.json({ received: true, ignored: true });

  const companyId = object?.metadata?.company_id ?? object?.metadata?.companyId ??
    (event.data?.object as any)?.subscription_details?.metadata?.company_id;
  if (!/^[1-9][0-9]{0,18}$/.test(String(companyId ?? "")))
    return Response.json({ received: true, ignored: true, reason: "missing_company_id" });
  const digest = createHash("sha256").update(raw).digest("hex");
  let verifiedCheckout: { subscriptionId: string; planKey: string } | null = null;
  if (checkout) {
    const key = (process.env as Record<string, string | undefined>).STRIPE_TEST_SECRET_KEY;
    if (!key?.startsWith("sk_test_") || !object?.id?.startsWith("cs_test_"))
      return Response.json({ error: "Stripe staging configuration missing" }, { status: 503 });
    try {
      const stripe = new Stripe(key, { apiVersion: "2024-06-20" });
      const session = await stripe.checkout.sessions.retrieve(object.id);
      const subId = subscriptionId(session.subscription as CheckoutSession["subscription"]);
      if (session.id !== object.id || session.mode !== "subscription" ||
          session.status !== "complete" || session.payment_status !== "paid" ||
          session.client_reference_id !== String(companyId) ||
          session.metadata?.companyId !== String(companyId) || !subId ||
          subId !== subscriptionId(object.subscription))
        return Response.json({ received: true, ignored: true, reason: "checkout_not_verified" });
      const sub = await stripe.subscriptions.retrieve(subId);
      const planKey = session.metadata?.planKey;
      if (sub.metadata.companyId !== String(companyId) ||
          sub.metadata.planKey !== planKey ||
          !["basic", "basic_pro", "major", "major_pro"].includes(planKey ?? ""))
        return Response.json({ received: true, ignored: true, reason: "subscription_not_verified" });
      verifiedCheckout = { subscriptionId: subId, planKey: planKey! };
    } catch (error) {
      console.error("Stripe staging verification failed", error);
      return Response.json({ error: "Stripe verification unavailable" }, { status: 502 });
    }
  }

  // Checkout metadata is untrusted. Never activate a company solely from a CLI
  // trigger or a client-supplied companyId: require a pre-bound subscription.
  const stripeSub = checkout ? subscriptionId(object?.subscription) : null;
  if (checkout && (object?.mode !== "subscription" || object?.status !== "complete" ||
      object?.payment_status !== "paid" || !stripeSub))
    return Response.json({ received: true, ignored: true, reason: "unpaid_or_incomplete_checkout" });

  try {
    const result = await db.transaction().execute(async trx => {
      const company = await trx.selectFrom("companies")
        .select(["id", "stripeSubscriptionId", "billingPlan"])
        .where("id", "=", String(companyId)).forUpdate().executeTakeFirst();
      if (!company) return "unknown_company";
      const existing = await trx.selectFrom("stripeProcessedEvents")
        .select(["payloadSha256", "companyId"]).where("eventId", "=", event.id).executeTakeFirst();
      if (existing) return existing.payloadSha256 === digest && String(existing.companyId) === String(companyId) ? "duplicate" : "conflict";

      if (checkout) {
        // Binding must be established by a server-authenticated checkout creation
        // flow, not by metadata supplied in the webhook event.
        const selected = await trx.selectFrom("companyPlanSelections")
          .select(["planId", "extraWorkers"]).where("companyId", "=", String(companyId)).executeTakeFirst();
        if (!verifiedCheckout || !selected || selected.planId !== verifiedCheckout.planKey ||
            selected.extraWorkers !== 0 ||
            (company.stripeSubscriptionId && company.stripeSubscriptionId !== verifiedCheckout.subscriptionId))
          return "unbound_checkout";
        await trx.updateTable("companies").set({
          stripeSubscriptionId: verifiedCheckout.subscriptionId,
          billingPlan: verifiedCheckout.planKey,
        }).where("id", "=", String(companyId)).execute();
      }

      const current = await trx.selectFrom("companyBillingStates")
        .select("state").where("companyId", "=", String(companyId)).executeTakeFirst();
      const prior = (current?.state ?? "active") as BillingState;
      const next = checkout ? "active" :
        action === "paid" && prior === "active" ? "active" : billingTransition(prior, action!);

      await trx.insertInto("stripeProcessedEvents").values({
        eventId: event.id, eventType: event.type, companyId: String(companyId),
        payloadSha256: digest, stripeSubscriptionId: checkout ? stripeSub : company.stripeSubscriptionId,
      }).execute();
      await trx.insertInto("companyBillingStates").values({
        companyId: String(companyId), state: next, lastEventId: event.id,
      }).onConflict(oc => oc.column("companyId").doUpdateSet({
        state: next, lastEventId: event.id, updatedAt: new Date(),
      })).execute();
      if (checkout || action === "paid") {
        await trx.updateTable("companies").set({ billingStatus: "active" })
          .where("id", "=", String(companyId)).execute();
      } else if (action === "failed") {
        await trx.updateTable("companies").set({ billingStatus: "overdue" })
          .where("id", "=", String(companyId)).execute();
      }
      return next;
    });
    if (result === "unknown_company") return Response.json({ error: result }, { status: 404 });
    if (result === "conflict") return Response.json({ error: result }, { status: 409 });
    if (result === "unbound_checkout") return Response.json({ received: true, ignored: true, reason: result });
    if ((process.env as Record<string, string | undefined>).STRIPE_MODE === "test")
      console.log("[STRIPE STAGING] event verification", { eventId: event.id, result, persisted: result !== "duplicate" });
    return Response.json({ received: true, result });
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}