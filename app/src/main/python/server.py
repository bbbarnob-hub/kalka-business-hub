"""KALKA BUSINESS HUB — the local business API.

This runs *on the phone* inside the APK, or on a desktop machine. It stores
everything in one SQLite file and exposes a token-authenticated JSON API.
The app shell talks to it over the local WebView bridge.

Design notes
------------
* Roles come from the database on every request. The client never asserts a role.
* Project History requires the admin role AND a short-lived grant that is only
  issued after a native biometric unlock reported by the Android bridge.
* All writes are transactional; money and stock are validated server-side.
"""
import json
import os
import re
import secrets
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, send_file
from werkzeug.security import check_password_hash, generate_password_hash

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("KALKA_DATA_DIR") or os.path.join(APP_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "kalka.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
LOCK = threading.RLock()

STATUSES = ["Draft", "New", "Assigned", "Accepted", "Rejected", "Production Started",
            "In Production", "Ready for Review", "Revision Requested", "Approved",
            "Ready for Delivery", "Out for Delivery", "Delivered", "Completed", "Cancelled"]

TRANSITIONS = {
    "Draft": {"admin": ["New", "Cancelled"]},
    "New": {"admin": ["Assigned", "Cancelled", "Draft"]},
    "Assigned": {"partner": ["Accepted", "Rejected"], "admin": ["Cancelled", "New"]},
    "Accepted": {"partner": ["Production Started", "Rejected"], "admin": ["Cancelled"]},
    "Rejected": {"admin": ["Assigned", "Cancelled", "New"]},
    "Production Started": {"partner": ["In Production"], "admin": ["Cancelled"]},
    "In Production": {"partner": ["Ready for Review"], "admin": ["Cancelled"]},
    "Ready for Review": {"admin": ["Approved", "Revision Requested", "Cancelled"]},
    "Revision Requested": {"partner": ["In Production", "Ready for Review"], "admin": ["Cancelled"]},
    "Approved": {"partner": ["Ready for Delivery"], "admin": ["Cancelled"]},
    "Ready for Delivery": {"partner": ["Out for Delivery", "Delivered"], "admin": ["Cancelled"]},
    "Out for Delivery": {"partner": ["Delivered"], "admin": ["Cancelled"]},
    "Delivered": {"admin": ["Completed"], "partner": []},
    "Completed": {"admin": []},
    "Cancelled": {"admin": []},
}

ARCHIVE_STATUSES = ("Completed", "Cancelled")
INCOME_CATEGORIES = ["Customer Advance Payment", "Customer Remaining Payment",
                     "Full Order Payment", "Other Business Income"]
EXPENSE_CATEGORIES = ["Fabric Purchase", "Production Expense", "Labour Cost", "Material Cost",
                      "Packaging", "Delivery", "Transportation", "Other Business Expense"]
INVENTORY_CATEGORIES = ["Ready-Made Punjabi", "Fabric", "Raw Material", "Packaging", "Other Supply"]
PAYMENT_METHODS = ["Cash", "UPI", "Bank Transfer", "Other"]

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, role TEXT CHECK(role IN ('admin','partner')),
  is_active INTEGER DEFAULT 1, full_name TEXT DEFAULT '', phone TEXT DEFAULT '',
  password_hash TEXT, must_change_pw INTEGER DEFAULT 1, failed_logins INTEGER DEFAULT 0,
  locked_until TEXT, last_login_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, device TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS security (
  id INTEGER PRIMARY KEY CHECK(id=1), biometric_enabled INTEGER DEFAULT 0,
  biometric_user TEXT, unlock_minutes INTEGER DEFAULT 10, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS history_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT DEFAULT '',
  address TEXT DEFAULT '', city TEXT DEFAULT '', notes TEXT DEFAULT '', preferences TEXT DEFAULT '',
  is_deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cust_dedupe ON customers(phone, lower(full_name)) WHERE is_deleted=0;
CREATE TABLE IF NOT EXISTS measurement_fields (
  id TEXT PRIMARY KEY, field_key TEXT UNIQUE, label TEXT, unit TEXT DEFAULT 'in', sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  version INTEGER DEFAULT 1, values_json TEXT DEFAULT '{}', notes TEXT DEFAULT '',
  measured_at TEXT DEFAULT (datetime('now')), created_by TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, order_number TEXT UNIQUE NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'New', design_name TEXT DEFAULT '', design_code TEXT DEFAULT '',
  fabric_colour TEXT DEFAULT '', size TEXT DEFAULT '', measurements_id TEXT,
  custom_instructions TEXT DEFAULT '', special_requirements TEXT DEFAULT '',
  order_price REAL DEFAULT 0, advance_paid REAL DEFAULT 0, expected_delivery TEXT,
  additional_notes TEXT DEFAULT '', cancellation_reason TEXT, assigned_partner_id TEXT,
  created_by TEXT, is_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_name TEXT, design_code TEXT DEFAULT '', fabric_colour TEXT DEFAULT '', size TEXT DEFAULT '',
  quantity INTEGER DEFAULT 1, unit_price REAL DEFAULT 0, notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL, assigned_by TEXT, assigned_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT, rejected_at TEXT, reject_reason TEXT, UNIQUE(order_id, partner_id)
);
CREATE TABLE IF NOT EXISTS status_history (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT, changed_by TEXT, role TEXT, note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT, file_name TEXT, mime TEXT DEFAULT 'image/jpeg', size_bytes INTEGER DEFAULT 0,
  uploaded_by TEXT, revision_no INTEGER DEFAULT 0, is_superseded INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  revision_no INTEGER, notes TEXT, requested_by TEXT, resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier TEXT DEFAULT '', tracking_no TEXT DEFAULT '', dispatched_at TEXT, delivered_at TEXT,
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, project_code TEXT UNIQUE, order_id TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL, title TEXT DEFAULT '', status TEXT DEFAULT 'Active',
  assigned_partner_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_history (
  id TEXT PRIMARY KEY, project_code TEXT UNIQUE, order_id TEXT UNIQUE NOT NULL,
  order_number TEXT, customer_id TEXT, customer_snapshot TEXT DEFAULT '{}',
  order_snapshot TEXT DEFAULT '{}', photos_snapshot TEXT DEFAULT '[]',
  revisions_snapshot TEXT DEFAULT '[]', timeline_snapshot TEXT DEFAULT '[]',
  finance_snapshot TEXT DEFAULT '{}', delivery_snapshot TEXT DEFAULT '{}',
  activity_snapshot TEXT DEFAULT '[]', final_status TEXT, final_amount REAL DEFAULT 0,
  cancellation_reason TEXT, archived_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY, item_name TEXT NOT NULL, product_code TEXT DEFAULT '', category TEXT,
  design TEXT DEFAULT '', colour TEXT DEFAULT '', size TEXT DEFAULT '', quantity REAL DEFAULT 0,
  unit TEXT DEFAULT 'pcs', purchase_cost REAL DEFAULT 0, min_stock REAL DEFAULT 0,
  supplier TEXT DEFAULT '', is_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_tx (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  kind TEXT, quantity REAL, qty_before REAL, qty_after REAL, reason TEXT DEFAULT '',
  order_id TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance (
  id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('income','expense')), amount REAL CHECK(amount>0),
  category TEXT, txn_date TEXT, description TEXT DEFAULT '', order_id TEXT,
  payment_method TEXT DEFAULT 'Cash', reference_no TEXT DEFAULT '',
  added_by TEXT, approval_status TEXT DEFAULT 'approved', approved_by TEXT, approved_at TEXT,
  reject_reason TEXT, dedupe_hash TEXT UNIQUE, is_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expense_approvals (
  id TEXT PRIMARY KEY, txn_id TEXT NOT NULL REFERENCES finance(id) ON DELETE CASCADE,
  action TEXT, reason TEXT DEFAULT '', acted_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS partner_payments (
  id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, amount REAL CHECK(amount>0),
  method TEXT DEFAULT 'Cash', reference_no TEXT DEFAULT '', paid_on TEXT, notes TEXT DEFAULT '',
  recorded_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, kind TEXT, order_id TEXT, title TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, last_read_at TEXT, PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL, body TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT, mime TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0, name TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT, title TEXT, body TEXT DEFAULT '', link TEXT DEFAULT '', order_id TEXT,
  is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, user_id TEXT, user_role TEXT DEFAULT '', action TEXT, entity TEXT DEFAULT '',
  entity_id TEXT DEFAULT '', old_value TEXT, new_value TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
BEGIN SELECT RAISE(ABORT,'activity log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity
BEGIN SELECT RAISE(ABORT,'activity log is append-only'); END;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
"""


# ------------------------------------------------------------------ helpers
def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def nid(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:14]}"


def sha(v):
    import hashlib
    return hashlib.sha256(v.encode()).hexdigest()


def jload(v, d):
    try:
        return json.loads(v) if v else d
    except Exception:
        return d


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA busy_timeout = 15000")
    return con


def migrate():
    con = connect()
    con.executescript(SCHEMA)
    # additive migrations for installs created before the open-registration model
    cols = [r[1] for r in con.execute("PRAGMA table_info(users)")]
    if "slot" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN slot INTEGER")
    if "verified" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 1")
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slot ON users(slot) WHERE slot IS NOT NULL")
    con.execute("CREATE TABLE IF NOT EXISTS claim_attempts (id TEXT PRIMARY KEY, role TEXT, "
                "email TEXT, ip TEXT, at TEXT DEFAULT (datetime('now')))")
    con.close()


def fnum(v, d=0.0):
    try:
        return float(v) if v not in (None, "") else d
    except (TypeError, ValueError):
        return d


def inum(v, d=0):
    try:
        return int(float(v)) if v not in (None, "") else d
    except (TypeError, ValueError):
        return d


def s(v, n=500):
    return ("" if v is None else str(v)).strip()[:n]


# ------------------------------------------------------------------ seed
def seed():
    """Bootstrap: no accounts are pre-created.

    The first two people to sign up claim slot 1 (Admin) and slot 2 (Partner).
    After both slots are filled the app is closed to everyone else. The owner
    keeps a permanent override so they can always recover access.
    """
    con = connect()
    if not con.execute("SELECT 1 FROM settings WHERE key='owner_email'").fetchone():
        owner = os.environ.get("KALKA_OWNER_EMAIL", "bbarnob@gmail.com")
        con.execute("INSERT INTO settings(key,value) VALUES ('owner_email',?)", (owner,))
        con.execute("INSERT INTO settings(key,value) VALUES ('business_name','Rithika Kalka Studio')")
        con.execute("INSERT INTO settings(key,value) VALUES ('business_tagline','Custom Punjabi clothing & design')")
        con.execute("INSERT INTO settings(key,value) VALUES ('currency','INR')")
        con.execute("INSERT INTO conversations(id,kind,title) VALUES ('conv_direct','direct','Admin & Partner')")
        for i, (k, l) in enumerate((("chest", "Chest"), ("waist", "Waist"), ("shoulder", "Shoulder"),
                                    ("sleeve", "Sleeve"), ("kurta_length", "Kurta Length"),
                                    ("neck", "Neck"), ("hip", "Hip")), start=1):
            con.execute("INSERT INTO measurement_fields(id,field_key,label,sort_order) VALUES (?,?,?,?)",
                        ("mf_" + k, k, l, i))
    con.close()
    return None


def slots_open(con):
    return con.execute("SELECT COUNT(*) c FROM users WHERE slot IS NOT NULL").fetchone()["c"] < 2


def slot_owner(con, slot):
    return con.execute("SELECT * FROM users WHERE slot=?", (slot,)).fetchone()


# ------------------------------------------------------------------ core services
def audit(con, user, action, entity="", eid="", old=None, new=None):
    try:
        con.execute("INSERT INTO activity(id,user_id,user_role,action,entity,entity_id,old_value,new_value,created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (nid("log"), (user or {}).get("id"), (user or {}).get("role", ""), action, entity,
                     str(eid or ""), json.dumps(old, default=str) if old is not None else None,
                     json.dumps(new, default=str) if new is not None else None, now()))
    except Exception:
        pass


def notify(con, user_id, event, title, body="", link="", order_id=None):
    con.execute("INSERT INTO notifications(id,user_id,event,title,body,link,order_id,created_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (nid("ntf"), user_id, event, title[:180], body[:500], link, order_id, now()))


def admins(con):
    return [r["id"] for r in con.execute("SELECT id FROM users WHERE role='admin'")]


def partners(con):
    return [r["id"] for r in con.execute("SELECT id FROM users WHERE role='partner'")]


def notify_admins(con, event, title, body="", link="", order_id=None):
    for a in admins(con):
        notify(con, a, event, title, body, link, order_id)


def next_order_number(con):
    n = (con.execute("SELECT COUNT(*) c FROM orders").fetchone()["c"] or 0) + 1
    year = datetime.now().year
    while True:
        cand = f"KBH-{year}-{n:04d}"
        if not con.execute("SELECT 1 FROM orders WHERE order_number=?", (cand,)).fetchone():
            return cand
        n += 1


def next_project_code(con):
    return f"PRJ-{(con.execute('SELECT COUNT(*) c FROM projects').fetchone()['c'] or 0) + 1:04d}"


def ensure_project(con, order_id):
    row = con.execute("SELECT * FROM projects WHERE order_id=?", (order_id,)).fetchone()
    if row:
        return row
    o = con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not o:
        return None
    pid = nid("prj")
    con.execute("INSERT INTO projects(id,project_code,order_id,customer_id,title,status,assigned_partner_id)"
                " VALUES (?,?,?,?,?,?,?)",
                (pid, next_project_code(con), order_id, o["customer_id"],
                 o["design_name"] or o["order_number"], "Active", o["assigned_partner_id"]))
    return con.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()


def sync_project(con, order_id):
    o = con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not o:
        return
    ensure_project(con, order_id)
    m = {"Completed": "Completed", "Cancelled": "Cancelled", "Ready for Review": "Ready for Review",
         "Approved": "Approved", "Ready for Delivery": "Ready for Delivery",
         "Out for Delivery": "Out for Delivery", "In Production": "Under Production",
         "Production Started": "Under Production", "Revision Requested": "Under Production"}
    con.execute("UPDATE projects SET status=?, assigned_partner_id=?, title=?, updated_at=? WHERE order_id=?",
                (m.get(o["status"], "Active"), o["assigned_partner_id"],
                 o["design_name"] or o["order_number"], now(), order_id))


def archive_project(con, order_id):
    """Idempotent: one row per order, updated in place on repeat calls."""
    o = con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not o or o["status"] not in ARCHIVE_STATUSES:
        return None
    proj = ensure_project(con, order_id)
    cust = con.execute("SELECT * FROM customers WHERE id=?", (o["customer_id"],)).fetchone()
    photos = [dict(r) for r in con.execute("SELECT id,kind,file_name,mime,revision_no,is_superseded,created_at"
                                           " FROM photos WHERE order_id=? ORDER BY created_at", (order_id,))]
    revs = [dict(r) for r in con.execute("SELECT revision_no,notes,created_at,resolved_at FROM revisions"
                                         " WHERE order_id=? ORDER BY revision_no", (order_id,))]
    tl = [dict(r) for r in con.execute("SELECT from_status,to_status,changed_by,role,note,created_at"
                                       " FROM status_history WHERE order_id=? ORDER BY created_at", (order_id,))]
    act = [dict(r) for r in con.execute("SELECT user_id,user_role,action,entity,entity_id,created_at"
                                        " FROM activity WHERE entity IN ('order','photo') AND entity_id=?"
                                        " ORDER BY created_at LIMIT 300", (order_id,))]
    fin = [dict(r) for r in con.execute("SELECT kind,amount,category,txn_date,description,payment_method,"
                                        "approval_status FROM finance WHERE order_id=? AND is_deleted=0",
                                        (order_id,))]
    dl = con.execute("SELECT * FROM deliveries WHERE order_id=?", (order_id,)).fetchone()
    items = [dict(r) for r in con.execute("SELECT * FROM order_items WHERE order_id=?", (order_id,))]
    inc = sum(f["amount"] for f in fin if f["kind"] == "income" and f["approval_status"] == "approved")
    exp = sum(f["amount"] for f in fin if f["kind"] == "expense" and f["approval_status"] == "approved")

    payload = {
        "project_code": proj["project_code"] if proj else f"PRJ-{o['order_number']}",
        "order_number": o["order_number"], "customer_id": o["customer_id"],
        "customer_snapshot": json.dumps(dict(cust) if cust else {}, default=str),
        "order_snapshot": json.dumps({**dict(o), "items": items}, default=str),
        "photos_snapshot": json.dumps(photos, default=str),
        "revisions_snapshot": json.dumps(revs, default=str),
        "timeline_snapshot": json.dumps(tl, default=str),
        "finance_snapshot": json.dumps({"transactions": fin, "income": inc, "expense": exp,
                                        "profit": round(inc - exp, 2)}, default=str),
        "delivery_snapshot": json.dumps(dict(dl) if dl else {}, default=str),
        "activity_snapshot": json.dumps(act, default=str),
        "final_status": o["status"], "final_amount": float(o["order_price"] or 0),
        "cancellation_reason": o["cancellation_reason"],
    }
    ex = con.execute("SELECT id FROM project_history WHERE order_id=?", (order_id,)).fetchone()
    if ex:
        sets = ", ".join(f"{k}=?" for k in payload)
        con.execute(f"UPDATE project_history SET {sets}, updated_at=? WHERE order_id=?",
                    (*payload.values(), now(), order_id))
        return ex["id"]
    hid = nid("hist")
    con.execute(f"INSERT INTO project_history(id,{', '.join(payload)},archived_at)"
                f" VALUES (?,{', '.join('?' for _ in payload)},?)",
                (hid, *payload.values(), now()))
    return hid


def set_status(con, order_id, to_status, user, note="", reason=None):
    o = con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not o:
        raise ValueError("order not found")
    if to_status not in TRANSITIONS.get(o["status"], {}).get(user["role"], []):
        raise PermissionError(f"{user['role']} cannot move {o['status']} → {to_status}")
    if to_status == "Cancelled" and not (reason or "").strip():
        raise ValueError("a cancellation reason is required")
    con.execute("UPDATE orders SET status=?, cancellation_reason=COALESCE(?, cancellation_reason),"
                " updated_at=?, completed_at=CASE WHEN ?='Completed' THEN ? ELSE completed_at END"
                " WHERE id=?", (to_status, reason, now(), to_status, now(), order_id))
    con.execute("INSERT INTO status_history(id,order_id,from_status,to_status,changed_by,role,note,created_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (nid("osh"), order_id, o["status"], to_status, user["id"], user["role"], note[:500], now()))
    audit(con, user, f"order.status.{to_status}", "order", order_id, {"status": o["status"]},
          {"status": to_status})
    sync_project(con, order_id)
    if to_status in ARCHIVE_STATUSES:
        archive_project(con, order_id)
    label = o["order_number"]
    if user["role"] == "partner":
        notify_admins(con, "order_status", f"{label}: {to_status}", note or "", f"/admin/order/{order_id}",
                      order_id)
    else:
        for p in partners(con):
            notify(con, p, "order_status", f"{label}: {to_status}", note or "",
                   f"/partner/order/{order_id}", order_id)
    return to_status


def assign_order(con, order_id, partner_id, user):
    o = con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not o:
        raise ValueError("order not found")
    p = con.execute("SELECT * FROM users WHERE id=? AND role='partner'", (partner_id,)).fetchone()
    if not p:
        raise ValueError("partner not found")
    if not p["is_active"]:
        raise ValueError("partner account is not authorized")
    con.execute("INSERT INTO assignments(id,order_id,partner_id,assigned_by,assigned_at)"
                " VALUES (?,?,?,?,?) ON CONFLICT(order_id,partner_id) DO UPDATE SET"
                " assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at,"
                " rejected_at=NULL, reject_reason=NULL",
                (nid("asg"), order_id, partner_id, user["id"], now()))
    con.execute("UPDATE orders SET assigned_partner_id=?, updated_at=? WHERE id=?",
                (partner_id, now(), order_id))
    if o["status"] in ("Draft", "New", "Rejected"):
        con.execute("UPDATE orders SET status='Assigned', updated_at=? WHERE id=?", (now(), order_id))
        con.execute("INSERT INTO status_history(id,order_id,from_status,to_status,changed_by,role,note,created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (nid("osh"), order_id, o["status"], "Assigned", user["id"], user["role"],
                     "Assigned to partner", now()))
    audit(con, user, "order.assign", "order", order_id, None, {"partner": partner_id})
    sync_project(con, order_id)
    notify(con, partner_id, "order_assigned", f"New order assigned: {o['order_number']}",
           o["design_name"] or "", f"/partner/order/{order_id}", order_id)


def totals(con, d_from=None, d_to=None):
    w, args = ["is_deleted=0"], []
    if d_from:
        w.append("txn_date>=?"); args.append(d_from)
    if d_to:
        w.append("txn_date<=?"); args.append(d_to)
    wh = " AND ".join(w)
    inc = con.execute(f"SELECT COALESCE(SUM(amount),0) v FROM finance WHERE {wh}"
                      f" AND kind='income' AND approval_status='approved'", args).fetchone()["v"]
    exp = con.execute(f"SELECT COALESCE(SUM(amount),0) v FROM finance WHERE {wh}"
                      f" AND kind='expense' AND approval_status='approved'", args).fetchone()["v"]
    pen = con.execute(f"SELECT COALESCE(SUM(amount),0) v FROM finance WHERE {wh}"
                      f" AND kind='expense' AND approval_status='pending'", args).fetchone()["v"]
    return {"income": round(inc, 2), "expense": round(exp, 2), "pending": round(pen, 2),
            "profit": round(inc - exp, 2)}


def stock_move(con, item_id, kind, qty, user, reason="", order_id=None):
    it = con.execute("SELECT * FROM inventory WHERE id=? AND is_deleted=0", (item_id,)).fetchone()
    if not it:
        raise ValueError("item not found")
    before = float(it["quantity"])
    q = abs(float(qty))
    after = before + q if kind == "in" else (q if kind == "adjust" else before - q)
    if after < 0:
        raise ValueError("stock cannot go negative")
    con.execute("UPDATE inventory SET quantity=?, updated_at=? WHERE id=?", (after, now(), item_id))
    con.execute("INSERT INTO inventory_tx(id,item_id,kind,quantity,qty_before,qty_after,reason,order_id,"
                "created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (nid("itx"), item_id, kind, q, before, after, reason[:300], order_id, user["id"], now()))
    audit(con, user, f"inventory.{kind}", "inventory", item_id, {"qty": before}, {"qty": after})
    if after <= float(it["min_stock"] or 0):
        for a in admins(con):
            notify(con, a, "low_stock", f"Low stock: {it['item_name']}",
                   f"{after:g} {it['unit']} left", "/admin/inventory")
    return after


# ------------------------------------------------------------------ app factory
def create_app():
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024
    migrate()
    seed()

    @app.before_request
    def _user():
        g.db = connect()
        g.user = None
        tok = request.headers.get("X-Kalka-Token", "")
        if tok:
            row = g.db.execute("SELECT s.id sid,s.expires_at,s.revoked_at,u.* FROM sessions s"
                               " JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
                               (sha(tok),)).fetchone()
            if row and not row["revoked_at"] and row["is_active"]:
                try:
                    exp = datetime.fromisoformat(row["expires_at"])
                    if exp > datetime.now(timezone.utc):
                        g.db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (now(), row["sid"]))
                        g.user = {"id": row["id"], "email": row["email"], "role": row["role"],
                                  "full_name": row["full_name"], "phone": row["phone"],
                                  "must_change_pw": bool(row["must_change_pw"]), "session_id": row["sid"]}
                except Exception:
                    pass

    @app.teardown_request
    def _close(_e=None):
        con = g.pop("db", None)
        if con is not None:
            try:
                con.close()
            except Exception:
                pass

    @app.after_request
    def _h(r):
        r.headers["X-Content-Type-Options"] = "nosniff"
        r.headers["Cache-Control"] = "no-store"
        return r

    def need(*roles):
        def deco(fn):
            @wraps(fn)
            def w(*a, **kw):
                if not g.user:
                    return jsonify({"error": "authentication required", "code": "unauth"}), 401
                if roles and g.user["role"] not in roles:
                    audit(g.db, g.user, "access_denied", "route", request.path)
                    return jsonify({"error": "forbidden", "code": "forbidden"}), 403
                return fn(*a, **kw)
            return w
        return deco

    def need_grant(fn):
        @wraps(fn)
        @need("admin")
        def w(*a, **kw):
            tok = request.headers.get("X-History-Grant", "")
            row = g.db.execute("SELECT * FROM history_grants WHERE token_hash=? AND user_id=?",
                               (sha(tok), g.user["id"])).fetchone() if tok else None
            ok = False
            if row:
                try:
                    ok = datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc)
                except Exception:
                    ok = False
            if not ok:
                return jsonify({"error": "biometric authentication required",
                                "code": "history_locked"}), 403
            return fn(*a, **kw)
        return w

    def bad(m, c=400):
        return jsonify({"error": m, "code": "bad_request"}), c

    # ---------------------------------------------------------- auth
    def make_session(con, user_id, device):
        tok = secrets.token_urlsafe(32)
        con.execute("INSERT INTO sessions(id,user_id,token_hash,device,created_at,last_seen,expires_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (nid("ses"), user_id, sha(tok), s(device, 120), now(), now(),
                     (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(timespec="seconds")))
        return tok

    def owner_email(con):
        r = con.execute("SELECT value FROM settings WHERE key='owner_email'").fetchone()
        return (r["value"] if r else "").lower()

    def user_json(row):
        return {"id": row["id"], "email": row["email"], "role": row["role"],
                "fullName": row["full_name"], "phone": row["phone"] or "",
                "mustChangePassword": bool(row["must_change_pw"]), "slot": row["slot"]}

    @app.get("/api/bootstrap")
    def bootstrap():
        """Public: tells the sign-in screen what to show. No emails are exposed."""
        con = g.db
        rows = con.execute("SELECT slot,role FROM users WHERE slot IS NOT NULL").fetchall()
        taken = {r["slot"]: r["role"] for r in rows}
        return jsonify({"open": len(taken) < 2,
                        "adminTaken": 1 in taken, "partnerTaken": 2 in taken,
                        "businessName": (con.execute("SELECT value FROM settings"
                                                     " WHERE key='business_name'").fetchone() or {"value": ""})["value"]})

    @app.post("/api/login")
    def login():
        """Sign in, or claim a free slot.

        * First two distinct people claim Admin (slot 1) then Partner (slot 2).
        * A returning account signs in with its own password — and only into the
          role it already owns; picking the other role is refused.
        * Once both slots are taken, any other email is refused.
        * The owner email can always get in as Admin (recovery).
        """
        d = request.get_json(silent=True) or {}
        email = s(d.get("email"), 200).lower()
        pw = str(d.get("password") or "")
        role = s(d.get("role"), 20).lower()
        con = g.db
        if not email or "@" not in email:
            return jsonify({"error": "Enter a valid email address", "code": "bad_email"}), 400
        if len(pw) < 8:
            return jsonify({"error": "Password must be at least 8 characters", "code": "weak_password"}), 400
        if role not in ("admin", "partner"):
            return jsonify({"error": "Choose Admin or Partner", "code": "role_required"}), 400

        row = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()

        # ---------- returning account ----------
        # Signing in is always allowed for an existing account, whatever card is
        # selected. The selected role only decides which slot a NEW account claims;
        # an existing account is refused if the chosen card is not its real role.
        if row:
            if not check_password_hash(row["password_hash"] or "", pw):
                con.execute("UPDATE users SET failed_logins=COALESCE(failed_logins,0)+1 WHERE id=?",
                            (row["id"],))
                audit(con, None, "auth.login.failed", "user", email)
                return jsonify({"error": "Wrong password for this account", "code": "invalid_credentials"}), 401
            if not row["is_active"]:
                return jsonify({"error": "This account has been suspended", "code": "not_authorized"}), 403
            if row["role"] != role:
                other = "Admin" if row["role"] == "admin" else "Partner"
                return jsonify({"error": f"This email is registered as {other}. Choose {other} to sign in.",
                                "code": "role_mismatch", "actualRole": row["role"]}), 403
            tok = make_session(con, row["id"], request.headers.get("User-Agent", ""))
            con.execute("UPDATE users SET last_login_at=?, failed_logins=0 WHERE id=?", (now(), row["id"]))
            audit(con, {"id": row["id"], "role": row["role"]}, "auth.login", "user", row["id"])
            return jsonify({"token": tok, "user": user_json(row), "claimed": False})

        # ---------- owner recovery ----------
        if email == owner_email(con):
            if con.execute("SELECT 1 FROM users WHERE slot=1").fetchone():
                return jsonify({"error": "Owner slot is already linked to another email",
                                "code": "slot_taken"}), 403
            slot, role = 1, "admin"
        else:
            # ---------- new account: claim a free slot ----------
            desired = 1 if role == "admin" else 2
            if slot_owner(con, desired):
                who = "Admin" if desired == 1 else "Partner"
                return jsonify({"error": f"The {who} slot is already taken. Only two accounts can use this app.",
                                "code": "slot_taken"}), 403
            if not slots_open(con):
                return jsonify({"error": "This app is already set up for two people. No more accounts can be added.",
                                "code": "closed"}), 403
            # the other slot may still be free — allow claiming it
            if desired == 1 and slot_owner(con, 2):
                return jsonify({"error": "Partner slot is taken. Claim the Admin slot.", "code": "slot_taken"}), 403
            slot = desired

        uid = "usr_admin" if slot == 1 else "usr_partner"
        try:
            con.execute("BEGIN")
            con.execute("INSERT INTO users(id,email,role,is_active,full_name,password_hash,must_change_pw,"
                        "slot,verified,created_at) VALUES (?,?,?,1,?,?,0,?,1,?)",
                        (uid, email, role, s(d.get("name"), 120) or email.split("@")[0].title(),
                         generate_password_hash(pw), slot, now()))
            con.execute("INSERT OR IGNORE INTO conversation_members(conversation_id,user_id)"
                        " VALUES ('conv_direct',?)", (uid,))
            con.execute("COMMIT")
        except Exception as e:
            con.execute("ROLLBACK")
            return jsonify({"error": f"Could not create the account: {e}", "code": "failed"}), 500

        row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        tok = make_session(con, uid, request.headers.get("User-Agent", ""))
        con.execute("UPDATE users SET last_login_at=? WHERE id=?", (now(), uid))
        audit(con, {"id": uid, "role": role}, "auth.claim", "user", uid, None, {"slot": slot})
        label = "Admin" if slot == 1 else "Partner"
        if slot == 2:
            for a in admins(con):
                notify(con, a, "partner_joined", "Your partner has joined",
                       f"{email} registered as Partner", "/admin/settings")
        return jsonify({"token": tok, "user": user_json(row), "claimed": True, "roleLabel": label})

    @app.post("/api/logout")
    @need()
    def logout():
        g.db.execute("UPDATE sessions SET revoked_at=? WHERE id=?", (now(), g.user["session_id"]))
        return jsonify({"ok": True})

    @app.get("/api/me")
    def me():
        if not g.user:
            return jsonify({"user": None})
        sec = g.db.execute("SELECT * FROM security WHERE id=1").fetchone()
        urow = g.db.execute("SELECT slot FROM users WHERE id=?", (g.user["id"],)).fetchone()
        return jsonify({"user": {"id": g.user["id"], "email": g.user["email"], "role": g.user["role"],
                                 "fullName": g.user["full_name"], "phone": g.user["phone"],
                                 "mustChangePassword": g.user["must_change_pw"],
                                 "slot": urow["slot"] if urow else None},
                        "security": {"biometricEnabled": bool(sec["biometric_enabled"]),
                                     "unlockMinutes": sec["unlock_minutes"],
                                     "canConfigure": g.user["role"] == "admin"}})

    @app.post("/api/change-password")
    @need()
    def change_pw():
        d = request.get_json(silent=True) or {}
        row = g.db.execute("SELECT password_hash FROM users WHERE id=?", (g.user["id"],)).fetchone()
        if not check_password_hash(row["password_hash"], str(d.get("currentPassword") or "")):
            return bad("Current password is incorrect")
        new = str(d.get("newPassword") or "")
        if len(new) < 8:
            return bad("New password must be at least 8 characters")
        g.db.execute("UPDATE users SET password_hash=?, must_change_pw=0 WHERE id=?",
                     (generate_password_hash(new), g.user["id"]))
        g.db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>?",
                     (now(), g.user["id"], g.user["session_id"]))
        audit(g.db, g.user, "auth.password_changed", "user", g.user["id"])
        return jsonify({"ok": True})

    # ---------------------------------------------------------- biometric gate
    @app.get("/api/security")
    @need()
    def security_get():
        sec = g.db.execute("SELECT * FROM security WHERE id=1").fetchone()
        return jsonify({"biometricEnabled": bool(sec["biometric_enabled"]),
                        "unlockMinutes": sec["unlock_minutes"],
                        "canConfigure": g.user["role"] == "admin"})

    @app.post("/api/security/enable")
    @need("admin")
    def security_enable():
        """Called by the app only after the OS biometric prompt succeeded."""
        d = request.get_json(silent=True) or {}
        if not d.get("nativeVerified"):
            return jsonify({"error": "Native biometric verification was not confirmed",
                            "code": "not_verified"}), 403
        g.db.execute("UPDATE security SET biometric_enabled=1, biometric_user=?, updated_at=? WHERE id=1",
                     (g.user["id"], now()))
        audit(g.db, g.user, "security.biometric.enabled", "user", g.user["id"])
        return jsonify({"ok": True, "biometricEnabled": True})

    @app.post("/api/security/disable")
    @need("admin")
    def security_disable():
        g.db.execute("UPDATE security SET biometric_enabled=0, biometric_user=NULL, updated_at=? WHERE id=1",
                     (now(),))
        audit(g.db, g.user, "security.biometric.disabled", "user", g.user["id"])
        return jsonify({"ok": True, "biometricEnabled": False})

    @app.post("/api/security/unlock")
    @need("admin")
    def security_unlock():
        """Exchange a successful native biometric check for a short history grant."""
        d = request.get_json(silent=True) or {}
        if not d.get("nativeVerified"):
            return jsonify({"error": "Biometric verification failed", "code": "verify_failed"}), 403
        sec = g.db.execute("SELECT * FROM security WHERE id=1").fetchone()
        if not sec["biometric_enabled"]:
            return jsonify({"error": "Biometric protection is not enabled", "code": "not_enabled"}), 400
        minutes = int(sec["unlock_minutes"] or 10)
        tok = secrets.token_urlsafe(32)
        g.db.execute("INSERT INTO history_grants(id,user_id,token_hash,expires_at,created_at)"
                     " VALUES (?,?,?,?,?)",
                     (nid("hgr"), g.user["id"], sha(tok),
                      (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(timespec="seconds"),
                      now()))
        audit(g.db, g.user, "security.biometric.verified", "user", g.user["id"])
        return jsonify({"grant": tok, "expiresInMinutes": minutes})

    @app.post("/api/security/unlock-minutes")
    @need("admin")
    def security_minutes():
        d = request.get_json(silent=True) or {}
        g.db.execute("UPDATE security SET unlock_minutes=?, updated_at=? WHERE id=1",
                     (max(1, min(120, inum(d.get("minutes"), 10))), now()))
        return jsonify({"ok": True})

    @app.get("/api/accounts")
    @need("admin")
    def accounts():
        rows = g.db.execute("SELECT id,email,role,is_active,full_name,last_login_at FROM users").fetchall()
        return jsonify({"accounts": [dict(r) for r in rows]})

    @app.post("/api/accounts/<uid>/authorize")
    @need("admin")
    def authorize(uid):
        d = request.get_json(silent=True) or {}
        row = g.db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row or row["role"] == "admin":
            return bad("Only the partner account can be authorized")
        active = 1 if d.get("active", True) else 0
        g.db.execute("UPDATE users SET is_active=? WHERE id=?", (active, uid))
        audit(g.db, g.user, "account.authorize" if active else "account.suspend", "user", uid)
        return jsonify({"ok": True})

    # ---------------------------------------------------------- dashboard
    @app.get("/api/dashboard")
    @need()
    def dashboard():
        con = g.db
        if g.user["role"] == "partner":
            uid = g.user["id"]
            def c(where):
                return con.execute(f"SELECT COUNT(*) v FROM orders WHERE assigned_partner_id=? AND"
                                   f" is_deleted=0 AND {where}", (uid,)).fetchone()["v"]
            pend = con.execute("SELECT COUNT(*) c,COALESCE(SUM(amount),0) v FROM finance WHERE added_by=?"
                               " AND approval_status='pending' AND is_deleted=0", (uid,)).fetchone()
            return jsonify({"role": "partner",
                            "assigned": c("status='Assigned'"), "accepted": c("status='Accepted'"),
                            "inProduction": c("status IN ('Production Started','In Production','Revision Requested')"),
                            "readyForReview": c("status='Ready for Review'"),
                            "readyForDelivery": c("status IN ('Approved','Ready for Delivery')"),
                            "completed": c("status IN ('Delivered','Completed')"),
                            "stock": con.execute("SELECT COALESCE(SUM(quantity),0) v FROM inventory"
                                                 " WHERE is_deleted=0").fetchone()["v"],
                            "lowStock": [dict(r) for r in con.execute(
                                "SELECT id,item_name,quantity,unit,min_stock FROM inventory WHERE is_deleted=0"
                                " AND quantity<=min_stock")],
                            "pendingExpenses": {"count": pend["c"], "amount": round(pend["v"], 2)},
                            "recent": [dict(r) for r in con.execute(
                                "SELECT o.id,o.order_number,o.status,o.expected_delivery,c.full_name FROM orders o"
                                " JOIN customers c ON c.id=o.customer_id WHERE o.assigned_partner_id=?"
                                " AND o.is_deleted=0 ORDER BY o.updated_at DESC LIMIT 6", (uid,))]})
        counts = {st: con.execute("SELECT COUNT(*) v FROM orders WHERE status=? AND is_deleted=0",
                                  (st,)).fetchone()["v"] for st in STATUSES}
        monthly = []
        for i in range(5, -1, -1):
            m = (datetime.now(timezone.utc).replace(day=1) - timedelta(days=30 * i)).strftime("%Y-%m")
            inc = con.execute("SELECT COALESCE(SUM(amount),0) v FROM finance WHERE kind='income'"
                              " AND approval_status='approved' AND is_deleted=0 AND substr(txn_date,1,7)=?",
                              (m,)).fetchone()["v"]
            exp = con.execute("SELECT COALESCE(SUM(amount),0) v FROM finance WHERE kind='expense'"
                              " AND approval_status='approved' AND is_deleted=0 AND substr(txn_date,1,7)=?",
                              (m,)).fetchone()["v"]
            monthly.append({"month": m, "income": round(inc, 2), "expense": round(exp, 2)})
        return jsonify({
            "role": "admin", "orders": counts,
            "totalOrders": con.execute("SELECT COUNT(*) v FROM orders WHERE is_deleted=0").fetchone()["v"],
            "totalCustomers": con.execute("SELECT COUNT(*) v FROM customers WHERE is_deleted=0").fetchone()["v"],
            "stock": con.execute("SELECT COALESCE(SUM(quantity),0) v FROM inventory WHERE is_deleted=0").fetchone()["v"],
            "lowStock": [dict(r) for r in con.execute(
                "SELECT id,item_name,quantity,unit,min_stock FROM inventory WHERE is_deleted=0"
                " AND quantity<=min_stock LIMIT 12")],
            "finance": totals(con),
            "pendingCustomer": round(con.execute(
                "SELECT COALESCE(SUM(MAX(order_price-advance_paid,0)),0) v FROM orders WHERE is_deleted=0"
                " AND status NOT IN ('Cancelled','Draft')").fetchone()["v"], 2),
            "pendingExpenses": dict(con.execute(
                "SELECT COUNT(*) count,COALESCE(SUM(amount),0) amount FROM finance WHERE kind='expense'"
                " AND approval_status='pending' AND is_deleted=0").fetchone()),
            "recent": [dict(r) for r in con.execute(
                "SELECT o.id,o.order_number,o.status,o.order_price,o.updated_at,c.full_name FROM orders o"
                " JOIN customers c ON c.id=o.customer_id WHERE o.is_deleted=0"
                " ORDER BY o.updated_at DESC LIMIT 6")],
            "activity": [dict(r) for r in con.execute(
                "SELECT action,user_role,created_at FROM activity ORDER BY created_at DESC LIMIT 10")],
            "deadlines": [dict(r) for r in con.execute(
                "SELECT o.id,o.order_number,o.expected_delivery,c.full_name FROM orders o"
                " JOIN customers c ON c.id=o.customer_id WHERE o.is_deleted=0 AND o.expected_delivery IS NOT NULL"
                " AND o.status NOT IN ('Completed','Cancelled') ORDER BY o.expected_delivery LIMIT 6")],
            "monthly": monthly,
            "statusChart": [{"status": k, "count": v} for k, v in counts.items() if v],
        })

    # ---------------------------------------------------------- customers
    def upsert_customer(con, d, user):
        cid = s(d.get("customerId"), 60)
        if cid:
            row = con.execute("SELECT * FROM customers WHERE id=? AND is_deleted=0", (cid,)).fetchone()
            if row:
                con.execute("UPDATE customers SET full_name=?,phone=?,email=?,address=?,city=?,notes=?,"
                            "preferences=?,updated_at=? WHERE id=?",
                            (s(d.get("customerName") or row["full_name"], 120),
                             s(d.get("customerPhone") or row["phone"], 30),
                             s(d.get("customerEmail") or row["email"], 160),
                             s(d.get("customerAddress") or row["address"], 400),
                             s(d.get("customerCity") or row["city"], 80),
                             s(d.get("customerNotes") or row["notes"], 800),
                             s(d.get("customerPreferences") or row["preferences"], 800), now(), cid))
                return cid
        name, phone = s(d.get("customerName"), 120), s(d.get("customerPhone"), 30)
        if not name or not phone:
            raise ValueError("Customer name and phone are required")
        ex = con.execute("SELECT id FROM customers WHERE phone=? AND lower(full_name)=lower(?)"
                         " AND is_deleted=0", (phone, name)).fetchone()
        if ex:
            return ex["id"]
        new = nid("cus")
        con.execute("INSERT INTO customers(id,full_name,phone,email,address,city,notes,preferences)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (new, name, phone, s(d.get("customerEmail"), 160), s(d.get("customerAddress"), 400),
                     s(d.get("customerCity"), 80), s(d.get("customerNotes"), 800),
                     s(d.get("customerPreferences"), 800)))
        audit(con, user, "customer.created", "customer", new, None, {"name": name})
        return new

    @app.get("/api/customers")
    @need()
    def customers():
        q = s(request.args.get("q"), 100)
        sql = "SELECT * FROM customers WHERE is_deleted=0"
        args = []
        if q:
            sql += " AND (lower(full_name) LIKE ? OR phone LIKE ?)"
            args += [f"%{q.lower()}%", f"%{q}%"]
        sql += " ORDER BY updated_at DESC LIMIT 200"
        rows = []
        for r in g.db.execute(sql, args):
            d = dict(r)
            d["orderCount"] = g.db.execute("SELECT COUNT(*) c FROM orders WHERE customer_id=?"
                                           " AND is_deleted=0", (r["id"],)).fetchone()["c"]
            if g.user["role"] == "partner":
                mine = g.db.execute("SELECT 1 FROM orders WHERE customer_id=? AND assigned_partner_id=?"
                                    " AND is_deleted=0", (r["id"], g.user["id"])).fetchone()
                if not mine:
                    continue
                d.pop("notes", None)
            rows.append(d)
        return jsonify({"customers": rows})

    @app.post("/api/customers")
    @need("admin")
    def customer_create():
        d = request.get_json(silent=True) or {}
        try:
            return jsonify({"ok": True, "id": upsert_customer(g.db, d, g.user)})
        except ValueError as e:
            return bad(str(e))

    @app.get("/api/customers/<cid>")
    @need()
    def customer_get(cid):
        con = g.db
        row = con.execute("SELECT * FROM customers WHERE id=? AND is_deleted=0", (cid,)).fetchone()
        if not row:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if g.user["role"] == "partner":
            ok = con.execute("SELECT 1 FROM orders WHERE customer_id=? AND assigned_partner_id=?"
                             " AND is_deleted=0", (cid, g.user["id"])).fetchone()
            if not ok:
                return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        data = {"customer": dict(row),
                "orders": [dict(o) for o in con.execute(
                    "SELECT id,order_number,status,design_name,order_price,created_at FROM orders"
                    " WHERE customer_id=? AND is_deleted=0 ORDER BY created_at DESC", (cid,))],
                "measurements": [dict(m) for m in con.execute(
                    "SELECT id,version,values_json,notes,measured_at FROM measurements WHERE customer_id=?"
                    " ORDER BY version DESC", (cid,))]}
        for m in data["measurements"]:
            m["values"] = jload(m.pop("values_json"), {})
        if g.user["role"] == "partner":
            data["customer"].pop("notes", None)
            for o in data["orders"]:
                o.pop("order_price", None)
        else:
            data["payments"] = [dict(p) for p in con.execute(
                "SELECT id,kind,amount,category,txn_date,payment_method,approval_status FROM finance"
                " WHERE order_id IN (SELECT id FROM orders WHERE customer_id=?) AND is_deleted=0"
                " ORDER BY txn_date DESC", (cid,))]
        return jsonify(data)

    @app.post("/api/customers/<cid>/measurements")
    @need("admin")
    def measurement_add(cid):
        d = request.get_json(silent=True) or {}
        con = g.db
        last = con.execute("SELECT COALESCE(MAX(version),0) v FROM measurements WHERE customer_id=?",
                           (cid,)).fetchone()["v"]
        mid = nid("mea")
        con.execute("INSERT INTO measurements(id,customer_id,version,values_json,notes,measured_at,created_by)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (mid, cid, last + 1, json.dumps(d.get("values") or {}), s(d.get("notes"), 600),
                     now(), g.user["id"]))
        audit(con, g.user, "measurement.created", "customer", cid, None, {"version": last + 1})
        return jsonify({"ok": True, "id": mid, "version": last + 1})

    @app.get("/api/measurement-fields")
    @need()
    def mfields():
        return jsonify({"fields": [dict(r) for r in g.db.execute(
            "SELECT * FROM measurement_fields ORDER BY sort_order")]})

    # ---------------------------------------------------------- orders
    def order_payload(con, r, full=True):
        c = con.execute("SELECT * FROM customers WHERE id=?", (r["customer_id"],)).fetchone()
        d = {"id": r["id"], "orderNumber": r["order_number"], "status": r["status"],
             "customerId": r["customer_id"], "customerName": c["full_name"] if c else "",
             "customerPhone": c["phone"] if c else "", "designName": r["design_name"],
             "designCode": r["design_code"], "fabricColour": r["fabric_colour"], "size": r["size"],
             "orderPrice": r["order_price"], "advancePaid": r["advance_paid"],
             "remaining": round((r["order_price"] or 0) - (r["advance_paid"] or 0), 2),
             "expectedDelivery": r["expected_delivery"], "createdAt": r["created_at"],
             "updatedAt": r["updated_at"], "cancellationReason": r["cancellation_reason"],
             "assignedPartnerId": r["assigned_partner_id"]}
        items = con.execute("SELECT * FROM order_items WHERE order_id=?", (r["id"],)).fetchall()
        d["items"] = [dict(i) for i in items]
        d["quantity"] = sum(i["quantity"] for i in items) or 1
        if not full:
            return d
        d.update({
            "customerEmail": c["email"] if c else "", "customerAddress": c["address"] if c else "",
            "customInstructions": r["custom_instructions"],
            "specialRequirements": r["special_requirements"],
            "additionalNotes": r["additional_notes"], "measurementsId": r["measurements_id"],
            "photos": [dict(p) for p in con.execute(
                "SELECT id,kind,file_name,mime,revision_no,is_superseded,created_at FROM photos"
                " WHERE order_id=? ORDER BY created_at", (r["id"],))],
            "timeline": [dict(t) for t in con.execute(
                "SELECT from_status,to_status,changed_by,role,note,created_at FROM status_history"
                " WHERE order_id=? ORDER BY created_at", (r["id"],))],
            "revisions": [dict(x) for x in con.execute(
                "SELECT revision_no,notes,created_at FROM revisions WHERE order_id=? ORDER BY revision_no",
                (r["id"],))],
            "delivery": dict(con.execute("SELECT * FROM deliveries WHERE order_id=?",
                                         (r["id"],)).fetchone() or {}),
            "project": dict(con.execute("SELECT * FROM projects WHERE order_id=?",
                                        (r["id"],)).fetchone() or {}),
            "allowedTransitions": TRANSITIONS.get(r["status"], {}).get(g.user["role"], []),
        })
        return d

    @app.get("/api/orders")
    @need()
    def orders_list():
        status = s(request.args.get("status"), 40)
        q = s(request.args.get("q"), 100)
        sql = ("SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.is_deleted=0")
        args = []
        if g.user["role"] == "partner":
            sql += " AND o.assigned_partner_id=?"; args.append(g.user["id"])
        if status and status not in ("all", "active"):
            sql += " AND o.status=?"; args.append(status)
        elif status == "active":
            sql += " AND o.status NOT IN ('Completed','Cancelled')"
        if q:
            sql += " AND (lower(o.order_number) LIKE ? OR lower(c.full_name) LIKE ? OR c.phone LIKE ?)"
            args += [f"%{q.lower()}%", f"%{q.lower()}%", f"%{q}%"]
        sql += " ORDER BY o.updated_at DESC LIMIT 200"
        return jsonify({"orders": [order_payload(g.db, r, False) for r in g.db.execute(sql, args)]})

    @app.post("/api/orders")
    @need("admin")
    def order_create():
        d = request.get_json(silent=True) or {}
        con = g.db
        try:
            con.execute("BEGIN")
            cid = upsert_customer(con, d, g.user)
            oid = nid("ord")
            num = next_order_number(con)
            st = "Draft" if d.get("draft") else "New"
            con.execute("INSERT INTO orders(id,order_number,customer_id,status,design_name,design_code,"
                        "fabric_colour,size,measurements_id,custom_instructions,special_requirements,"
                        "order_price,advance_paid,expected_delivery,additional_notes,created_by)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (oid, num, cid, st, s(d.get("designName"), 160), s(d.get("designCode"), 60),
                         s(d.get("fabricColour"), 60), s(d.get("size"), 40),
                         s(d.get("measurementsId"), 60) or None, s(d.get("customInstructions"), 1500),
                         s(d.get("specialRequirements"), 1500), fnum(d.get("orderPrice")),
                         fnum(d.get("advancePaid")), s(d.get("expectedDelivery"), 20) or None,
                         s(d.get("additionalNotes"), 1500), g.user["id"]))
            for it in (d.get("items") or []):
                con.execute("INSERT INTO order_items(id,order_id,item_name,design_code,fabric_colour,size,"
                            "quantity,unit_price,notes) VALUES (?,?,?,?,?,?,?,?,?)",
                            (nid("oit"), oid, s(it.get("itemName"), 160) or "Item",
                             s(it.get("designCode"), 60), s(it.get("fabricColour"), 60),
                             s(it.get("size"), 40), max(1, inum(it.get("quantity"), 1)),
                             fnum(it.get("unitPrice")), s(it.get("notes"), 300)))
            con.execute("INSERT INTO status_history(id,order_id,from_status,to_status,changed_by,role,note,created_at)"
                        " VALUES (?,?,?,?,?,?,?,?)",
                        (nid("osh"), oid, None, st, g.user["id"], "admin", "Order created", now()))
            ensure_project(con, oid)
            audit(con, g.user, "order.created", "order", oid, None, {"number": num})
            con.execute("COMMIT")
        except ValueError as e:
            con.execute("ROLLBACK")
            return bad(str(e))
        except Exception as e:
            con.execute("ROLLBACK")
            return jsonify({"error": f"Could not create order: {e}", "code": "failed"}), 500
        return jsonify({"ok": True, "id": oid, "orderNumber": num, "status": st})

    @app.get("/api/orders/<oid>")
    @need()
    def order_get(oid):
        con = g.db
        r = con.execute("SELECT * FROM orders WHERE id=? AND is_deleted=0", (oid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if g.user["role"] == "partner" and r["assigned_partner_id"] != g.user["id"]:
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        p = order_payload(con, r, True)
        if g.user["role"] == "partner":
            for k in ("orderPrice", "advancePaid", "remaining"):
                p.pop(k, None)
        return jsonify(p)

    @app.post("/api/orders/<oid>/assign")
    @need("admin")
    def order_assign(oid):
        d = request.get_json(silent=True) or {}
        pid = s(d.get("partnerId"), 60) or (partners(g.db)[0] if partners(g.db) else "")
        try:
            assign_order(g.db, oid, pid, g.user)
        except ValueError as e:
            return bad(str(e))
        return jsonify({"ok": True})

    @app.post("/api/orders/<oid>/status")
    @need()
    def order_status(oid):
        con = g.db
        r = con.execute("SELECT * FROM orders WHERE id=? AND is_deleted=0", (oid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if g.user["role"] == "partner" and r["assigned_partner_id"] != g.user["id"]:
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        d = request.get_json(silent=True) or {}
        try:
            set_status(con, oid, s(d.get("status"), 40), g.user, s(d.get("note"), 600),
                       s(d.get("reason"), 400) or None)
        except PermissionError as e:
            return jsonify({"error": str(e), "code": "invalid_transition"}), 403
        except ValueError as e:
            return bad(str(e))
        return jsonify({"ok": True, "status": d.get("status")})

    @app.post("/api/orders/<oid>/revision")
    @need("admin")
    def order_revision(oid):
        con = g.db
        r = con.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if r["status"] != "Ready for Review":
            return bad("Revisions can only be requested while ready for review")
        d = request.get_json(silent=True) or {}
        notes = s(d.get("notes"), 1200)
        if not notes:
            return bad("Describe what needs correcting")
        last = con.execute("SELECT COALESCE(MAX(revision_no),0) v FROM revisions WHERE order_id=?",
                           (oid,)).fetchone()["v"]
        con.execute("INSERT INTO revisions(id,order_id,revision_no,notes,requested_by) VALUES (?,?,?,?,?)",
                    (nid("rev"), oid, last + 1, notes, g.user["id"]))
        con.execute("UPDATE photos SET is_superseded=1 WHERE order_id=? AND kind='completion'", (oid,))
        try:
            set_status(con, oid, "Revision Requested", g.user, notes)
        except (ValueError, PermissionError) as e:
            return bad(str(e))
        return jsonify({"ok": True, "revision": last + 1})

    # ---------------------------------------------------------- photos
    @app.post("/api/orders/<oid>/photos")
    @need()
    def photo_add(oid):
        con = g.db
        r = con.execute("SELECT * FROM orders WHERE id=? AND is_deleted=0", (oid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if g.user["role"] == "partner" and r["assigned_partner_id"] != g.user["id"]:
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        d = request.get_json(silent=True) or {}
        kind = s(d.get("kind"), 20) or "progress"
        if kind not in ("reference", "progress", "completion", "revision", "delivery"):
            return bad("Unknown photo type")
        if g.user["role"] == "partner" and kind == "reference":
            return bad("Only the admin can add reference images")
        data = str(d.get("dataUrl") or "")
        m = re.match(r"^data:(image/(?:jpeg|png|webp)|application/pdf);base64,(.+)$", data, re.S)
        if not m:
            return bad("Only JPEG, PNG, WebP images and PDF documents are accepted")
        import base64
        blob = base64.b64decode(m.group(2))
        if len(blob) > 8 * 1024 * 1024:
            return bad("File is larger than 8 MB")
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
               "application/pdf": ".pdf"}[m.group(1)]
        os.makedirs(os.path.join(UPLOAD_DIR, "orders"), exist_ok=True)
        name = f"{kind}-{secrets.token_hex(8)}{ext}"
        with open(os.path.join(UPLOAD_DIR, "orders", name), "wb") as f:
            f.write(blob)
        rev = con.execute("SELECT COALESCE(MAX(revision_no),0) v FROM revisions WHERE order_id=?",
                          (oid,)).fetchone()["v"]
        pid = nid("pho")
        con.execute("INSERT INTO photos(id,order_id,kind,file_name,mime,size_bytes,uploaded_by,revision_no)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (pid, oid, kind, name, m.group(1), len(blob), g.user["id"], rev))
        audit(con, g.user, f"photo.{kind}", "photo", pid, None, {"order": oid})
        if kind in ("progress", "completion"):
            notify_admins(con, "photo_uploaded", f"New {kind} photos on {r['order_number']}",
                          g.user["full_name"], f"/admin/order/{oid}", oid)
        return jsonify({"ok": True, "id": pid})

    @app.get("/api/photos/<pid>")
    @need()
    def photo_get(pid):
        con = g.db
        p = con.execute("SELECT * FROM photos WHERE id=?", (pid,)).fetchone()
        if not p:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        o = con.execute("SELECT * FROM orders WHERE id=?", (p["order_id"],)).fetchone()
        if g.user["role"] == "partner" and o["assigned_partner_id"] != g.user["id"]:
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        path = os.path.join(UPLOAD_DIR, "orders", p["file_name"])
        if not os.path.exists(path):
            return jsonify({"error": "missing", "code": "not_found"}), 404
        return send_file(path, mimetype=p["mime"], max_age=0)

    # ---------------------------------------------------------- projects
    @app.get("/api/projects")
    @need()
    def projects():
        status = s(request.args.get("status"), 40)
        sql = ("SELECT p.*,o.order_number,o.status order_status,c.full_name customer_name FROM projects p"
               " JOIN orders o ON o.id=p.order_id JOIN customers c ON c.id=p.customer_id WHERE o.is_deleted=0")
        args = []
        if g.user["role"] == "partner":
            sql += " AND p.assigned_partner_id=?"; args.append(g.user["id"])
        if status and status != "all":
            sql += " AND p.status=?"; args.append(status)
        sql += " ORDER BY p.updated_at DESC LIMIT 200"
        return jsonify({"projects": [dict(r) for r in g.db.execute(sql, args)]})

    # ---------------------------------------------------------- history (sealed)
    @app.get("/api/history")
    @need_grant
    def history_list():
        q = s(request.args.get("q"), 100).lower()
        status = s(request.args.get("status"), 20)
        year = s(request.args.get("year"), 4)
        month = s(request.args.get("month"), 2)
        sql = ("SELECT id,project_code,order_number,final_status,final_amount,archived_at,customer_snapshot"
               " FROM project_history WHERE 1=1")
        args = []
        if status and status != "all":
            sql += " AND final_status=?"; args.append(status)
        if year:
            sql += " AND substr(archived_at,1,4)=?"; args.append(year)
        if month:
            sql += " AND substr(archived_at,6,2)=?"; args.append(month)
        sql += " ORDER BY archived_at DESC LIMIT 400"
        out = []
        for r in g.db.execute(sql, args):
            cust = jload(r["customer_snapshot"], {})
            if q and q not in f"{r['order_number']} {r['project_code']} {cust.get('full_name','')}".lower():
                continue
            out.append({"id": r["id"], "projectCode": r["project_code"], "orderNumber": r["order_number"],
                        "customerName": cust.get("full_name", ""), "finalStatus": r["final_status"],
                        "finalAmount": r["final_amount"], "archivedAt": r["archived_at"]})
        audit(g.db, g.user, "history.listed", "project_history", "", None, {"count": len(out)})
        return jsonify({"history": out})

    @app.get("/api/history/<hid>")
    @need_grant
    def history_get(hid):
        r = g.db.execute("SELECT * FROM project_history WHERE id=?", (hid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        audit(g.db, g.user, "history.viewed", "project_history", hid)
        return jsonify({"id": r["id"], "projectCode": r["project_code"], "orderNumber": r["order_number"],
                        "finalStatus": r["final_status"], "finalAmount": r["final_amount"],
                        "cancellationReason": r["cancellation_reason"], "archivedAt": r["archived_at"],
                        "customer": jload(r["customer_snapshot"], {}), "order": jload(r["order_snapshot"], {}),
                        "photos": jload(r["photos_snapshot"], []), "revisions": jload(r["revisions_snapshot"], []),
                        "timeline": jload(r["timeline_snapshot"], []), "finance": jload(r["finance_snapshot"], {}),
                        "delivery": jload(r["delivery_snapshot"], {}),
                        "activity": jload(r["activity_snapshot"], [])})

    @app.get("/api/history/<hid>/photo/<pid>")
    @need_grant
    def history_photo(hid, pid):
        r = g.db.execute("SELECT photos_snapshot FROM project_history WHERE id=?", (hid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        p = next((x for x in jload(r["photos_snapshot"], []) if x.get("id") == pid), None)
        if not p:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        path = os.path.join(UPLOAD_DIR, "orders", p["file_name"])
        if not os.path.exists(path):
            return jsonify({"error": "missing", "code": "not_found"}), 404
        return send_file(path, mimetype=p.get("mime", "image/jpeg"), max_age=0)

    # ---------------------------------------------------------- inventory
    @app.get("/api/inventory")
    @need()
    def inventory_list():
        cat = s(request.args.get("category"), 60)
        q = s(request.args.get("q"), 80)
        sql = "SELECT * FROM inventory WHERE is_deleted=0"
        args = []
        if cat and cat != "all":
            sql += " AND category=?"; args.append(cat)
        if q:
            sql += " AND (lower(item_name) LIKE ? OR lower(product_code) LIKE ?)"
            args += [f"%{q.lower()}%"] * 2
        sql += " ORDER BY item_name LIMIT 300"
        rows = []
        for r in g.db.execute(sql, args):
            d = dict(r)
            d["low"] = d["quantity"] <= (d["min_stock"] or 0)
            if g.user["role"] == "partner":
                d.pop("purchase_cost", None)
            rows.append(d)
        return jsonify({"items": rows, "categories": INVENTORY_CATEGORIES})

    @app.post("/api/inventory")
    @need("admin")
    def inventory_create():
        d = request.get_json(silent=True) or {}
        if not s(d.get("itemName"), 160):
            return bad("Item name is required")
        iid = nid("inv")
        g.db.execute("INSERT INTO inventory(id,item_name,product_code,category,design,colour,size,quantity,"
                     "unit,purchase_cost,min_stock,supplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (iid, s(d.get("itemName"), 160), s(d.get("productCode"), 60),
                      s(d.get("category"), 60) or "Other Supply", s(d.get("design"), 120),
                      s(d.get("colour"), 40), s(d.get("size"), 40), fnum(d.get("quantity")),
                      s(d.get("unit"), 12) or "pcs", fnum(d.get("purchaseCost")),
                      fnum(d.get("minStock")), s(d.get("supplier"), 160)))
        audit(g.db, g.user, "inventory.created", "inventory", iid)
        return jsonify({"ok": True, "id": iid})

    @app.put("/api/inventory/<iid>")
    @need("admin")
    def inventory_update(iid):
        d = request.get_json(silent=True) or {}
        r = g.db.execute("SELECT * FROM inventory WHERE id=? AND is_deleted=0", (iid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        g.db.execute("UPDATE inventory SET item_name=?,product_code=?,category=?,design=?,colour=?,size=?,"
                     "unit=?,purchase_cost=?,min_stock=?,supplier=?,updated_at=? WHERE id=?",
                     (s(d.get("itemName") or r["item_name"], 160), s(d.get("productCode"), 60),
                      s(d.get("category") or r["category"], 60), s(d.get("design"), 120),
                      s(d.get("colour"), 40), s(d.get("size"), 40),
                      s(d.get("unit") or r["unit"], 12), fnum(d.get("purchaseCost"), r["purchase_cost"]),
                      fnum(d.get("minStock"), r["min_stock"]), s(d.get("supplier"), 160), now(), iid))
        audit(g.db, g.user, "inventory.updated", "inventory", iid)
        return jsonify({"ok": True})

    @app.delete("/api/inventory/<iid>")
    @need("admin")
    def inventory_delete(iid):
        g.db.execute("UPDATE inventory SET is_deleted=1, updated_at=? WHERE id=?", (now(), iid))
        audit(g.db, g.user, "inventory.deleted", "inventory", iid)
        return jsonify({"ok": True})

    @app.post("/api/inventory/<iid>/stock")
    @need()
    def inventory_stock(iid):
        d = request.get_json(silent=True) or {}
        kind = s(d.get("kind"), 10)
        if kind not in ("in", "out", "adjust"):
            return bad("Movement must be in, out or adjust")
        if kind == "adjust" and g.user["role"] != "admin":
            return jsonify({"error": "Only the admin can adjust stock", "code": "forbidden"}), 403
        try:
            g.db.execute("BEGIN")
            q = stock_move(g.db, iid, kind, fnum(d.get("quantity")), g.user, s(d.get("reason"), 200),
                           s(d.get("orderId"), 60) or None)
            g.db.execute("COMMIT")
        except ValueError as e:
            g.db.execute("ROLLBACK")
            return bad(str(e))
        return jsonify({"ok": True, "quantity": q})

    @app.get("/api/inventory/<iid>/history")
    @need()
    def inventory_history(iid):
        return jsonify({"history": [dict(r) for r in g.db.execute(
            "SELECT t.*,u.full_name who FROM inventory_tx t LEFT JOIN users u ON u.id=t.created_by"
            " WHERE t.item_id=? ORDER BY t.created_at DESC LIMIT 60", (iid,))]})

    # ---------------------------------------------------------- finance
    @app.get("/api/finance")
    @need()
    def finance_list():
        kind = s(request.args.get("kind"), 12)
        status = s(request.args.get("status"), 12)
        sql = ("SELECT f.*,u.full_name added_by_name,o.order_number FROM finance f"
               " LEFT JOIN users u ON u.id=f.added_by LEFT JOIN orders o ON o.id=f.order_id"
               " WHERE f.is_deleted=0")
        args = []
        if g.user["role"] == "partner":
            sql += " AND f.added_by=?"; args.append(g.user["id"])
        if kind and kind != "all":
            sql += " AND f.kind=?"; args.append(kind)
        if status and status != "all":
            sql += " AND f.approval_status=?"; args.append(status)
        sql += " ORDER BY f.txn_date DESC, f.created_at DESC LIMIT 300"
        return jsonify({"transactions": [dict(r) for r in g.db.execute(sql, args)],
                        "totals": totals(g.db) if g.user["role"] == "admin" else None,
                        "incomeCategories": INCOME_CATEGORIES, "expenseCategories": EXPENSE_CATEGORIES,
                        "paymentMethods": PAYMENT_METHODS})

    @app.post("/api/finance")
    @need()
    def finance_create():
        import hashlib
        d = request.get_json(silent=True) or {}
        kind = s(d.get("kind"), 12)
        if kind not in ("income", "expense"):
            return bad("Must be income or expense")
        if kind == "income" and g.user["role"] != "admin":
            return jsonify({"error": "Only the admin can record income", "code": "forbidden"}), 403
        amount = fnum(d.get("amount"))
        if amount <= 0:
            return bad("Amount must be greater than zero")
        order_id = s(d.get("orderId"), 60) or None
        if order_id and g.user["role"] == "partner":
            if not g.db.execute("SELECT 1 FROM orders WHERE id=? AND assigned_partner_id=?",
                                (order_id, g.user["id"])).fetchone():
                return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        date = s(d.get("txnDate"), 10) or datetime.now(timezone.utc).date().isoformat()
        cat = s(d.get("category"), 60)
        desc = s(d.get("description"), 400)
        h = hashlib.sha256(f"{kind}|{amount}|{date}|{cat}|{order_id}|{desc}".encode()).hexdigest()
        if g.db.execute("SELECT 1 FROM finance WHERE dedupe_hash=? AND is_deleted=0", (h,)).fetchone():
            return bad("This transaction has already been recorded", 409)
        st = "pending" if g.user["role"] == "partner" else "approved"
        fid = nid("fin")
        g.db.execute("INSERT INTO finance(id,kind,amount,category,txn_date,description,order_id,payment_method,"
                     "reference_no,added_by,approval_status,approved_by,approved_at,dedupe_hash)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (fid, kind, amount, cat, date, desc, order_id, s(d.get("paymentMethod"), 30) or "Cash",
                      s(d.get("referenceNo"), 60), g.user["id"], st,
                      g.user["id"] if st == "approved" else None, now() if st == "approved" else None, h))
        audit(g.db, g.user, f"finance.{kind}.created", "finance", fid, None, {"amount": amount, "status": st})
        if st == "pending":
            notify_admins(g.db, "expense_submitted", "Expense submitted for approval",
                          f"{g.user['full_name']} · ₹{amount:,.0f} ({cat})", "/admin/finance", order_id)
        return jsonify({"ok": True, "id": fid, "status": st})

    @app.post("/api/finance/<fid>/approve")
    @need("admin")
    def finance_approve(fid):
        d = request.get_json(silent=True) or {}
        approve = bool(d.get("approve", True))
        r = g.db.execute("SELECT * FROM finance WHERE id=? AND is_deleted=0", (fid,)).fetchone()
        if not r:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if r["approval_status"] != "pending":
            return bad("Already reviewed")
        if r["added_by"] == g.user["id"]:
            return jsonify({"error": "You cannot approve an expense you submitted yourself",
                            "code": "self_approval"}), 403
        st = "approved" if approve else "rejected"
        g.db.execute("UPDATE finance SET approval_status=?,approved_by=?,approved_at=?,reject_reason=?,"
                     "updated_at=? WHERE id=?",
                     (st, g.user["id"], now(), None if approve else s(d.get("reason"), 300), now(), fid))
        g.db.execute("INSERT INTO expense_approvals(id,txn_id,action,reason,acted_by) VALUES (?,?,?,?,?)",
                     (nid("eap"), fid, st, s(d.get("reason"), 300), g.user["id"]))
        audit(g.db, g.user, f"finance.expense.{st}", "finance", fid)
        notify(g.db, r["added_by"], "expense_" + st, f"Your expense of ₹{r['amount']:,.0f} was {st}",
               s(d.get("reason"), 300), "/partner/expenses")
        return jsonify({"ok": True, "status": st})

    @app.get("/api/partner-payments")
    @need()
    def ppayments():
        pid = g.user["id"] if g.user["role"] == "partner" else (partners(g.db)[0] if partners(g.db) else "")
        appr = g.db.execute("SELECT COALESCE(SUM(amount),0) v,COUNT(*) c FROM finance WHERE kind='expense'"
                            " AND approval_status='approved' AND added_by=? AND is_deleted=0",
                            (pid,)).fetchone()
        pend = g.db.execute("SELECT COALESCE(SUM(amount),0) v,COUNT(*) c FROM finance WHERE kind='expense'"
                            " AND approval_status='pending' AND added_by=? AND is_deleted=0",
                            (pid,)).fetchone()
        paid = g.db.execute("SELECT COALESCE(SUM(amount),0) v FROM partner_payments WHERE partner_id=?",
                            (pid,)).fetchone()["v"]
        return jsonify({"approvedExpenses": round(appr["v"], 2), "approvedCount": appr["c"],
                        "pendingExpenses": round(pend["v"], 2), "pendingCount": pend["c"],
                        "totalPaid": round(paid, 2), "balance": round(appr["v"] - paid, 2),
                        "payments": [dict(r) for r in g.db.execute(
                            "SELECT * FROM partner_payments WHERE partner_id=? ORDER BY paid_on DESC", (pid,))]})

    @app.post("/api/partner-payments")
    @need("admin")
    def ppayment_add():
        d = request.get_json(silent=True) or {}
        pid = s(d.get("partnerId"), 60) or (partners(g.db)[0] if partners(g.db) else "")
        amt = fnum(d.get("amount"))
        if amt <= 0 or not pid:
            return bad("Amount and partner are required")
        g.db.execute("INSERT INTO partner_payments(id,partner_id,amount,method,reference_no,paid_on,notes,recorded_by)"
                     " VALUES (?,?,?,?,?,?,?,?)",
                     (nid("pay"), pid, amt, s(d.get("method"), 30) or "Cash", s(d.get("referenceNo"), 60),
                      s(d.get("paidOn"), 10) or datetime.now(timezone.utc).date().isoformat(),
                      s(d.get("notes"), 300), g.user["id"]))
        audit(g.db, g.user, "partner_payment.recorded", "partner_payment", "", None, {"amount": amt})
        notify(g.db, pid, "partner_payment", f"Payment recorded: ₹{amt:,.0f}", "", "/partner/expenses")
        return jsonify({"ok": True})

    # ---------------------------------------------------------- chat
    @app.get("/api/chat")
    @need()
    def chat_list():
        out = []
        for c in g.db.execute("SELECT c.* FROM conversations c JOIN conversation_members m"
                              " ON m.conversation_id=c.id WHERE m.user_id=?", (g.user["id"],)):
            last = g.db.execute("SELECT body,created_at FROM messages WHERE conversation_id=?"
                                " ORDER BY created_at DESC LIMIT 1", (c["id"],)).fetchone()
            mem = g.db.execute("SELECT last_read_at FROM conversation_members WHERE conversation_id=?"
                               " AND user_id=?", (c["id"], g.user["id"])).fetchone()
            unread = g.db.execute("SELECT COUNT(*) c FROM messages WHERE conversation_id=? AND sender_id<>?"
                                  " AND (? IS NULL OR created_at>?)",
                                  (c["id"], g.user["id"], mem["last_read_at"], mem["last_read_at"])).fetchone()["c"]
            out.append({"id": c["id"], "title": c["title"], "kind": c["kind"],
                        "lastMessage": last["body"] if last else "", "unread": unread})
        return jsonify({"conversations": out})

    @app.post("/api/chat/order")
    @need()
    def chat_order():
        d = request.get_json(silent=True) or {}
        oid = s(d.get("orderId"), 60)
        o = g.db.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
        if not o:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if g.user["role"] == "partner" and o["assigned_partner_id"] != g.user["id"]:
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        ex = g.db.execute("SELECT id FROM conversations WHERE order_id=?", (oid,)).fetchone()
        if ex:
            return jsonify({"id": ex["id"]})
        cid = nid("cnv")
        g.db.execute("INSERT INTO conversations(id,kind,order_id,title) VALUES (?,?,?,?)",
                     (cid, "order", oid, f"Order {o['order_number']}"))
        for uid in admins(g.db) + partners(g.db):
            g.db.execute("INSERT OR IGNORE INTO conversation_members(conversation_id,user_id) VALUES (?,?)",
                         (cid, uid))
        return jsonify({"id": cid})

    @app.get("/api/chat/<cid>")
    @need()
    def chat_messages(cid):
        if not g.db.execute("SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
                            (cid, g.user["id"])).fetchone():
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        msgs = []
        for m in g.db.execute("SELECT m.*,u.full_name sender_name FROM messages m LEFT JOIN users u"
                              " ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.created_at LIMIT 300",
                              (cid,)):
            d = dict(m)
            d["attachments"] = [dict(a) for a in g.db.execute(
                "SELECT id,file_name,mime,name FROM attachments WHERE message_id=?", (m["id"],))]
            msgs.append(d)
        g.db.execute("UPDATE conversation_members SET last_read_at=? WHERE conversation_id=? AND user_id=?",
                     (now(), cid, g.user["id"]))
        return jsonify({"messages": msgs})

    @app.post("/api/chat/<cid>")
    @need()
    def chat_send(cid):
        if not g.db.execute("SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
                            (cid, g.user["id"])).fetchone():
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        d = request.get_json(silent=True) or {}
        body = s(d.get("body"), 3000)
        if not body:
            return bad("Message is empty")
        mid = nid("msg")
        g.db.execute("INSERT INTO messages(id,conversation_id,sender_id,body) VALUES (?,?,?,?)",
                     (mid, cid, g.user["id"], body))
        conv = g.db.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        for r in g.db.execute("SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>?",
                              (cid, g.user["id"])):
            notify(g.db, r["user_id"], "new_message", f"New message from {g.user['full_name']}",
                   body[:120], "/partner/chat" if g.user["role"] == "admin" else "/admin/chat",
                   conv["order_id"] if conv else None)
        return jsonify({"ok": True, "id": mid})

    @app.post("/api/chat/<cid>/attachment")
    @need()
    def chat_attach(cid):
        if not g.db.execute("SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
                            (cid, g.user["id"])).fetchone():
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        d = request.get_json(silent=True) or {}
        m = re.match(r"^data:(image/(?:jpeg|png|webp)|application/pdf);base64,(.+)$",
                     str(d.get("dataUrl") or ""), re.S)
        if not m:
            return bad("Only images and PDF documents can be shared")
        import base64
        blob = base64.b64decode(m.group(2))
        if len(blob) > 8 * 1024 * 1024:
            return bad("File is larger than 8 MB")
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
               "application/pdf": ".pdf"}[m.group(1)]
        name = secrets.token_hex(8) + ext
        os.makedirs(os.path.join(UPLOAD_DIR, "chat"), exist_ok=True)
        with open(os.path.join(UPLOAD_DIR, "chat", name), "wb") as f:
            f.write(blob)
        mid = nid("msg")
        g.db.execute("INSERT INTO messages(id,conversation_id,sender_id,body) VALUES (?,?,?,?)",
                     (mid, cid, g.user["id"], ""))
        g.db.execute("INSERT INTO attachments(id,message_id,file_name,mime,size_bytes,name) VALUES (?,?,?,?,?,?)",
                     (nid("att"), mid, name, m.group(1), len(blob), s(d.get("name"), 120) or name))
        return jsonify({"ok": True, "id": mid})

    @app.get("/api/chat/attachment/<aid>")
    @need()
    def chat_file(aid):
        a = g.db.execute("SELECT a.*,m.conversation_id FROM attachments a JOIN messages m ON m.id=a.message_id"
                         " WHERE a.id=?", (aid,)).fetchone()
        if not a:
            return jsonify({"error": "not found", "code": "not_found"}), 404
        if not g.db.execute("SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
                            (a["conversation_id"], g.user["id"])).fetchone():
            return jsonify({"error": "forbidden", "code": "forbidden"}), 403
        path = os.path.join(UPLOAD_DIR, "chat", a["file_name"])
        if not os.path.exists(path):
            return jsonify({"error": "missing", "code": "not_found"}), 404
        return send_file(path, mimetype=a["mime"], max_age=0)

    # ---------------------------------------------------------- notifications
    @app.get("/api/notifications")
    @need()
    def notifications():
        rows = [dict(r) for r in g.db.execute(
            "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 80",
            (g.user["id"],))]
        unread = g.db.execute("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0",
                              (g.user["id"],)).fetchone()["c"]
        return jsonify({"notifications": rows, "unread": unread})

    @app.post("/api/notifications/read")
    @need()
    def notif_read():
        g.db.execute("UPDATE notifications SET is_read=1 WHERE user_id=?", (g.user["id"],))
        return jsonify({"ok": True})

    # ---------------------------------------------------------- reports + settings
    def report_rows(kind, f, t):
        con = g.db
        if kind == "daily-sales":
            return [dict(r) for r in con.execute(
                "SELECT txn_date,COUNT(*) entries,SUM(amount) amount FROM finance WHERE kind='income'"
                " AND approval_status='approved' AND is_deleted=0 AND (? IS NULL OR txn_date>=?)"
                " AND (? IS NULL OR txn_date<=?) GROUP BY txn_date ORDER BY txn_date DESC", (f, f, t, t))]
        if kind == "monthly-revenue":
            return [dict(r) for r in con.execute(
                "SELECT substr(txn_date,1,7) month,SUM(amount) amount FROM finance WHERE kind='income'"
                " AND approval_status='approved' AND is_deleted=0 GROUP BY month ORDER BY month DESC")]
        if kind == "monthly-expense":
            return [dict(r) for r in con.execute(
                "SELECT substr(txn_date,1,7) month,category,SUM(amount) amount FROM finance"
                " WHERE kind='expense' AND approval_status='approved' AND is_deleted=0"
                " GROUP BY month,category ORDER BY month DESC")]
        if kind == "profit-loss":
            tt = totals(con, f, t)
            return [{"income": tt["income"], "expense": tt["expense"], "profit": tt["profit"]}]
        if kind == "customers":
            return [dict(r) for r in con.execute(
                "SELECT c.full_name,c.phone,c.city,COUNT(o.id) orders,COALESCE(SUM(o.order_price),0) value"
                " FROM customers c LEFT JOIN orders o ON o.customer_id=c.id AND o.is_deleted=0"
                " WHERE c.is_deleted=0 GROUP BY c.id ORDER BY value DESC")]
        if kind == "order-completion":
            return [dict(r) for r in con.execute(
                "SELECT order_number,status,order_price,created_at,completed_at FROM orders WHERE is_deleted=0"
                " AND status IN ('Delivered','Completed') ORDER BY completed_at DESC")]
        if kind == "cancelled":
            return [dict(r) for r in con.execute(
                "SELECT order_number,cancellation_reason,updated_at FROM orders WHERE status='Cancelled'"
                " AND is_deleted=0 ORDER BY updated_at DESC")]
        if kind == "inventory":
            return [dict(r) for r in con.execute(
                "SELECT item_name,category,colour,size,quantity,unit,purchase_cost,min_stock FROM inventory"
                " WHERE is_deleted=0 ORDER BY category,item_name")]
        if kind == "low-stock":
            return [dict(r) for r in con.execute(
                "SELECT item_name,category,quantity,unit,min_stock FROM inventory WHERE is_deleted=0"
                " AND quantity<=min_stock ORDER BY quantity")]
        if kind == "partner-activity":
            return [dict(r) for r in con.execute(
                "SELECT user_role,action,entity,entity_id,created_at FROM activity WHERE user_role='partner'"
                " ORDER BY created_at DESC LIMIT 300")]
        if kind == "payments":
            return [dict(r) for r in con.execute(
                "SELECT p.paid_on,p.amount,p.method,p.reference_no,u.full_name partner FROM partner_payments p"
                " LEFT JOIN users u ON u.id=p.partner_id ORDER BY p.paid_on DESC")]
        return []

    REPORTS = ["daily-sales", "monthly-revenue", "monthly-expense", "profit-loss", "customers",
               "order-completion", "cancelled", "inventory", "low-stock", "partner-activity", "payments"]

    @app.get("/api/reports/<kind>")
    @need("admin")
    def report(kind):
        if kind not in REPORTS:
            return jsonify({"error": "unknown report", "code": "not_found"}), 404
        f = s(request.args.get("from"), 10) or None
        t = s(request.args.get("to"), 10) or None
        audit(g.db, g.user, "report.viewed", "report", kind)
        return jsonify({"report": kind, "rows": report_rows(kind, f, t), "reports": REPORTS})

    @app.get("/api/activity")
    @need("admin")
    def activity_list():
        return jsonify({"activity": [dict(r) for r in g.db.execute(
            "SELECT a.*,u.full_name who FROM activity a LEFT JOIN users u ON u.id=a.user_id"
            " ORDER BY a.created_at DESC LIMIT 120")]})

    @app.get("/api/settings")
    @need()
    def settings_get():
        d = {r["key"]: r["value"] for r in g.db.execute("SELECT * FROM settings")}
        if g.user["role"] == "partner":
            d = {k: v for k, v in d.items() if k in ("business_name", "business_tagline", "currency")}
        return jsonify({"settings": d, "incomeCategories": INCOME_CATEGORIES,
                        "expenseCategories": EXPENSE_CATEGORIES,
                        "inventoryCategories": INVENTORY_CATEGORIES})

    @app.put("/api/settings")
    @need("admin")
    def settings_put():
        d = request.get_json(silent=True) or {}
        for k, v in d.items():
            if isinstance(k, str) and len(k) < 60:
                g.db.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE"
                             " SET value=excluded.value", (k, str(v)[:400]))
        audit(g.db, g.user, "settings.updated", "settings", "")
        return jsonify({"ok": True})

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "app": "KALKA BUSINESS HUB", "version": "1.0.0"})

    # ---------------------------------------------------------- static app
    WWW = os.environ.get("KALKA_WWW") or os.path.join(os.path.dirname(APP_DIR), "mobile", "www")

    @app.get("/")
    @app.get("/<path:path>")
    def static_app(path=""):
        if path.startswith("api/"):
            return jsonify({"error": "not found", "code": "not_found"}), 404
        target = os.path.join(WWW, path)
        if path and os.path.isfile(target):
            return send_file(target, max_age=0)
        return send_file(os.path.join(WWW, "index.html"), max_age=0)

    @app.errorhandler(404)
    def _404(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": "not found", "code": "not_found"}), 404
        return send_file(os.path.join(WWW, "index.html"))

    @app.errorhandler(413)
    def _413(e):
        return jsonify({"error": "That file is too large", "code": "too_large"}), 413

    return app


def start_server(data_dir, port):
    """Entry point used by the Android shell (Chaquopy)."""
    global DATA_DIR, DB_PATH, UPLOAD_DIR
    DATA_DIR = data_dir
    DB_PATH = os.path.join(DATA_DIR, "kalka.db")
    UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    a = create_app()
    a.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    a = create_app()
    creds = seed()
    port = int(os.environ.get("PORT", "8770"))
    print(f"KALKA BUSINESS HUB on http://127.0.0.1:{port}/")
    a.run(host="127.0.0.1", port=port, debug=False, threaded=True)
