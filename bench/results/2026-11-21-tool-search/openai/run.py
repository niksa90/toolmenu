import json, subprocess, sys, collections
OUT = sys.argv[1]
def fn(name, desc):
    return {"type": "function", "name": name, "description": desc, "defer_loading": True,
            "parameters": {"type": "object", "properties": {"customer_id": {"type": "string"}}, "required": ["customer_id"], "additionalProperties": False}}
crm_ops = ["list_open_orders","get_customer_profile","update_customer_email","list_customer_notes","add_customer_note","get_order","cancel_order","refund_order",
  "list_shipments","track_shipment","list_invoices_for_customer","get_loyalty_points","add_loyalty_points","list_support_tickets","open_support_ticket",
  "close_support_ticket","list_addresses","add_address","delete_address","list_payment_methods","get_lifetime_value","merge_customers","tag_customer",
  "untag_customer","list_segments","export_customer","list_returns","create_return","get_cart","clear_cart"]
assert len(crm_ops) == 30
billing_ops = ["create_invoice","void_invoice","list_invoices","get_invoice","charge_card","issue_credit","list_credits","get_balance","list_plans","change_plan"]
tools = [
  {"type": "namespace", "name": "crm", "description": "CRM tools for customer lookup and order management.",
   "tools": [fn(n, n.replace("_", " ").capitalize() + " for a customer ID.") for n in crm_ops]},
  {"type": "namespace", "name": "billing", "description": "Billing tools for invoices, charges and plans.",
   "tools": [fn(n, n.replace("_", " ").capitalize() + " for a customer ID.") for n in billing_ops]},
  {"type": "tool_search"},
]
results = []
for model in ["gpt-5.4", "gpt-6.2-astra"]:
    for run in range(3):
        body = {"model": model, "input": "List open orders for customer CUST-12345.", "tools": tools, "parallel_tool_calls": False}
        r = subprocess.run(["curl", "-sS", "-m", "120", "https://api.openai.com/v1/responses", "-H", "Authorization: Bearer proxy-injected",
                            "-H", "content-type: application/json", "-d", json.dumps(body)], capture_output=True, text=True)
        d = json.loads(r.stdout)
        json.dump(d, open(f"{OUT}/{model}-{run}.json", "w"), indent=1)
        if "error" in d and d["error"]:
            print(model, run, "ERROR", d["error"]); continue
        row = {"model": model, "run": run}
        for item in d.get("output", []):
            if item["type"] == "tool_search_call":
                row["call_args"] = item.get("arguments"); row["execution"] = item.get("execution")
            if item["type"] == "tool_search_output":
                loaded = collections.Counter()
                for t in item.get("tools", []):
                    if t.get("type") == "namespace":
                        loaded[t["name"]] += len(t.get("tools", []))
                    else:
                        loaded[t.get("type") + ":" + t.get("name", "?")] += 1
                row["loaded"] = dict(loaded)
            if item["type"] == "function_call":
                row["called"] = item.get("name") + " " + str(item.get("namespace", ""))
        row["usage_in"] = d.get("usage", {}).get("input_tokens")
        print(json.dumps(row)); results.append(row)
json.dump(results, open(f"{OUT}/summary.json", "w"), indent=1)
