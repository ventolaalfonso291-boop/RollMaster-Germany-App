from threading import Lock
from uuid import uuid4


class MemoryStore:
    def __init__(self):
        self.lock = Lock()
        self.customers = {}
        self.jobs = {}
        self.measurements = {}
        self.audit_logs = []

    def save_customer(self, data: dict) -> dict:
        with self.lock:
            cid = data.get("id") or str(uuid4())
            data["id"] = cid
            self.customers[cid] = data
            return data

    def get_customer_history(self, customer_id: str) -> list:
        with self.lock:
            return [j for j in self.jobs.values() if j.get("customer_id") == customer_id]

    def save_job(self, data: dict) -> dict:
        with self.lock:
            jid = data.get("id") or str(uuid4())
            data["id"] = jid
            self.jobs[jid] = data
            return data


db_store = MemoryStore()
