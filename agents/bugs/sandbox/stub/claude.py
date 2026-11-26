import json, os, sys, time

B = os.environ['QA_SANDBOX']
path = lambda name: os.path.join(B, name)
sys.stdin.read()
if os.path.exists(path('claude-delay')):
    time.sleep(float(open(path('claude-delay')).read()))
if os.path.exists(path('claude-fail')):
    print(json.dumps({'type': 'result', 'is_error': True, 'result': 'qa: модель недоступна'}))
elif os.path.exists(path('claude-reply.json')):
    reply = json.load(open(path('claude-reply.json')))
    print(json.dumps({'type': 'result', 'is_error': False, 'structured_output': reply, 'total_cost_usd': 0.14, 'usage': {'input_tokens': 1000, 'output_tokens': 200}}))
