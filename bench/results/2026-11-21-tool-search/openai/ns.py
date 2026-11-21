import json, subprocess, sys
OUT=sys.argv[1]
s={"type":"string"}
def fn(name, desc): return {"type":"function","name":name,"description":desc,"defer_loading":True,"parameters":{"type":"object","properties":{"id":s},"required":["id"],"additionalProperties":False}}
def ns(name, desc, product):
    return {"type":"namespace","name":name,"description":desc,"tools":[fn("get_issue",f"Get one {product} issue by its ID."),fn("search_issues",f"Search {product} issues."),fn("create_issue",f"Create a {product} issue."),fn("add_comment",f"Comment on a {product} issue.")]}
cases = {
 "distinct": [ns("jira","Jira: issues, sprints and boards for project tracking.","Jira"), ns("github","GitHub: repositories, pull requests and issues.","GitHub")],
 "lookalike": [ns("tracker","Issue tracker tools.","tracker"), ns("tracker_v2","Issue tracker tools.","tracker")],
}
asks = ["Get issue 42.", "Get Jira issue PROJ-42.", "Show me the bug report about login failures."]
for case, namespaces in cases.items():
  for model in ["gpt-5.4","gpt-6.2-astra"]:
    for ask in asks:
      for run in range(2):
        body={"model":model,"tools":namespaces+[{"type":"tool_search"}],"parallel_tool_calls":False,"input":ask}
        r=subprocess.run(["curl","-sS","-m","120","https://api.openai.com/v1/responses","-H","Authorization: Bearer proxy-injected","-H","content-type: application/json","-d",json.dumps(body)],capture_output=True,text=True)
        d=json.loads(r.stdout); json.dump(d,open(f"{OUT}/ns-{case}-{model}-{asks.index(ask)}-{run}.json","w"),indent=1)
        if d.get("error"): print(case,model,ask,"ERROR",d["error"]); continue
        searches=[it.get("arguments") for it in d.get("output",[]) if it["type"]=="tool_search_call"]
        called=[(it.get("namespace"),it.get("name")) for it in d.get("output",[]) if it["type"]=="function_call"]
        text=" ".join(c.get("text","") for it in d.get("output",[]) if it["type"]=="message" for c in it.get("content",[]))[:90]
        print(f"{case:9} {model:13} {ask[:34]:34} searches={json.dumps(searches)} called={called} {('said: '+text) if not called else ''}")
