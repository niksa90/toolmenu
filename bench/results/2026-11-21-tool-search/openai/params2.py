import json, subprocess, sys
OUT = sys.argv[1]
def fn(name, desc, props):
    return {"type": "function", "name": name, "description": desc, "defer_loading": True,
            "parameters": {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}}
s = {"type": "string"}
crm = [
  fn("get_customer_profile", "Fetch a customer profile by customer ID.", {"customer_id": s}),
  fn("list_open_orders", "List open orders for a customer ID.", {"customer_id": s}),
  # the unique word only in a PARAMETER NAME
  fn("update_settings", "Update account settings for a customer ID.", {"customer_id": s, "zephyrine_mode": s}),
  # the unique word only in a PARAMETER DESCRIPTION
  fn("export_data", "Export account data for a customer ID.", {"customer_id": s, "format": {"type": "string", "description": "Output format, for example a quokkalith archive."}}),
  # the unique word in the DESCRIPTION, as a control
  fn("archive_account", "Archive the account into the marmotide vault.", {"customer_id": s}),
] + [fn(f"noop_{i}", f"Does nothing number {i} for a customer ID.", {"customer_id": s}) for i in range(10)]
tools = [{"type": "namespace", "name": "crm", "description": "CRM tools for customer accounts.", "tools": crm}, {"type": "tool_search"}]
for model in ["gpt-5.4", "gpt-6.2-astra"]:
    for q in ["zephyrine_mode", "update settings"]:
        for run in range(1):
            body = {"model": model, "tools": tools, "parallel_tool_calls": False,
                    "input": f'Call tool_search exactly once with paths ["crm"] and the query exactly "{q}" (nothing else), then stop and do not call any other tool.'}
            r = subprocess.run(["curl","-sS","-m","120","https://api.openai.com/v1/responses","-H","Authorization: Bearer proxy-injected","-H","content-type: application/json","-d",json.dumps(body)],capture_output=True,text=True)
            d = json.loads(r.stdout); json.dump(d, open(f"{OUT}/params-{model}-{q}-{run}.json","w"), indent=1)
            if d.get("error"): print(model, q, "ERROR", d["error"]); continue
            args=None; names=[]
            for it in d.get("output",[]):
                if it["type"]=="tool_search_call": args=it.get("arguments")
                if it["type"]=="tool_search_output":
                    for t in it.get("tools",[]): names += [x["name"] for x in t.get("tools",[])] if t.get("type")=="namespace" else [t.get("name")]
            print(model, q, run, json.dumps(args), names)
