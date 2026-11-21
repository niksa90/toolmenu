import json, subprocess, sys, collections
sys.argv[1:] = sys.argv[1:]
OUT=sys.argv[1]
exec(open(OUT+"/run.py").read().split("results = []")[0].replace("OUT = sys.argv[1]","OUT = sys.argv[1]"))
for model in ["gpt-5.4", "gpt-6.2-astra"]:
    for q in ["customer", "purchases", "delete"]:
        for run in range(2):
            body = {"model": model, "tools": tools, "parallel_tool_calls": False,
                    "input": f'Call tool_search exactly once with paths ["crm"] and the query exactly "{q}" (nothing else), then stop and do not call any other tool.'}
            r = subprocess.run(["curl","-sS","-m","120","https://api.openai.com/v1/responses","-H","Authorization: Bearer proxy-injected","-H","content-type: application/json","-d",json.dumps(body)],capture_output=True,text=True)
            d = json.loads(r.stdout); json.dump(d, open(f"{OUT}/probe-{model}-{q}-{run}.json","w"), indent=1)
            args=None; names=[]
            for it in d.get("output",[]):
                if it["type"]=="tool_search_call": args=it.get("arguments")
                if it["type"]=="tool_search_output":
                    for t in it.get("tools",[]): names += [x["name"] for x in t.get("tools",[])] if t.get("type")=="namespace" else [t.get("name")]
            print(model, q, run, json.dumps(args), len(names), names)
