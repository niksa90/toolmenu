import json, os, subprocess, sys
OUT = sys.argv[1]
KEY = os.environ["GEMINI_API_KEY"]
def fn(name, desc, props=None):
    props = props or {"customer_id": {"type": "string"}}
    return {"type": "function", "name": name, "description": desc, "defer_loading": True,
            "parameters": {"type": "object", "properties": props, "required": list(props)}}
crm_ops = ["list_open_orders","get_customer_profile","update_customer_email","list_customer_notes","add_customer_note","get_order","cancel_order","refund_order",
  "list_shipments","track_shipment","list_invoices_for_customer","get_loyalty_points","add_loyalty_points","list_support_tickets","open_support_ticket",
  "close_support_ticket","list_addresses","add_address","delete_address","list_payment_methods","get_lifetime_value","merge_customers","tag_customer",
  "untag_customer","list_segments","export_customer","list_returns","create_return","get_cart","clear_cart"]
billing_ops = ["create_invoice","void_invoice","list_invoices","get_invoice","charge_card","issue_credit","list_credits","get_balance","list_plans","change_plan"]
base = [fn(n, n.replace("_", " ").capitalize() + " for a customer ID.") for n in crm_ops + billing_ops]
# a tool whose only distinctive word sits in a parameter description the model can't see
base.append(fn("export_data", "Export account data for a customer ID.", {"customer_id": {"type": "string"}, "format": {"type": "string", "description": "Output format, for example a quokkalith archive."}}))
lookalike = [fn("jira_get_issue", "Get one Jira issue by its ID.", {"id": {"type": "string"}}), fn("github_get_issue", "Get one GitHub issue by its ID.", {"id": {"type": "string"}}),
             fn("jira_search_issues", "Search Jira issues.", {"q": {"type": "string"}}), fn("github_search_issues", "Search GitHub issues.", {"q": {"type": "string"}})]
cases = [
  ("orders", base, "List open orders for customer CUST-12345."),
  ("purchases", base, "Show me what customer CUST-12345 has purchased that hasn't shipped yet."),
  ("param-only", base, "Export customer CUST-12345's data as a quokkalith archive."),
  ("lookalike-vague", lookalike, "Get issue 42."),
  ("lookalike-jira", lookalike, "Get Jira issue PROJ-42."),
]
for model in ["gemini-3.6-flash", "gemini-4-hydrogen"]:
    for case, tools, ask in cases:
        for run in range(2):
            body = {"model": model, "input": ask, "tools": [{"type": "tool_search"}] + tools}
            r = subprocess.run(["curl", "-sS", "-m", "180", "-X", "POST", "https://generativelanguage.googleapis.com/v1beta/interactions",
                                "-H", f"x-goog-api-key: {KEY}", "-H", "Content-Type: application/json", "-d", json.dumps(body)], capture_output=True, text=True)
            try: d = json.loads(r.stdout)
            except Exception: print(model, case, "BAD", r.stdout[:200]); continue
            json.dump(d, open(f"{OUT}/{model}-{case}-{run}.json", "w"), indent=1)
            if "error" in d: print(model, case, "ERROR", json.dumps(d["error"])[:300]); continue
            searched = [s.get("arguments", {}).get("function_names") for s in d.get("steps", []) if s.get("type") == "tool_search_call"]
            loaded = [[x.get("name") for x in s.get("result", [])] for s in d.get("steps", []) if s.get("type") == "tool_search_result"]
            called = [s.get("name") for s in d.get("steps", []) if s.get("type") == "function_call"]
            print(f"{model:17} {case:16} run{run} searched={json.dumps(searched)} loaded_counts={[len(l) for l in loaded]} called={called}")
