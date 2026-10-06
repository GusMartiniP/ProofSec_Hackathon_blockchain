"""
Checagem offline de templates SAM (sem sam/cfn-lint disponíveis).

1. YAML com tags intrínsecas (!Ref, !Sub, ...) → dicts no formato longo.
2. Referências: Ref/GetAtt/Sub apontam para parâmetro, recurso ou pseudo-parâmetro.
3. Parâmetros e condições não usados; condições inexistentes.
4. Recurso sem condição (ou com outra) referenciando recurso condicional.
5. Handlers Python existem; RouteSettings batem com as rotas.
6. IAM derivado do código (grafo de chamadas via AST) x IAM do template, por função.
7. Segredos: parâmetro do JWT só em auth/authorizer; nada de "*" em Action/Resource.

Uso: python check_template.py <template.yaml> [--functions-dir DIR]
"""
import ast
import os
import re
import sys

import yaml

PSEUDO = {
    "AWS::AccountId", "AWS::Region", "AWS::Partition", "AWS::StackName", "AWS::StackId",
    "AWS::NoValue", "AWS::URLSuffix", "AWS::NotificationARNs",
}
INTRINSICS = ["Ref", "Condition", "GetAtt", "Sub", "If", "Not", "Equals", "Join", "Select", "Split",
              "FindInMap", "Base64", "Cidr", "ImportValue", "GetAZs", "And", "Or", "Contains",
              "Transform", "ToJsonString", "Length"]


class CfnLoader(yaml.SafeLoader):
    pass


def _make(tag):
    def construct(loader, node):
        if isinstance(node, yaml.ScalarNode):
            value = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            value = loader.construct_sequence(node, deep=True)
        else:
            value = loader.construct_mapping(node, deep=True)
        if tag == "Ref":
            return {"Ref": value}
        if tag == "Condition":
            return {"Condition": value}
        if tag == "GetAtt" and isinstance(value, str):
            value = value.split(".", 1)
        return {f"Fn::{tag}": value}
    return construct


for _t in INTRINSICS:
    CfnLoader.add_constructor(f"!{_t}", _make(_t))


def load(path):
    with open(path, encoding="utf-8") as f:
        return yaml.load(f, Loader=CfnLoader)


# ---------------------------------------------------------------------------
problems, warnings = [], []


def err(msg):
    problems.append(msg)


def warn(msg):
    warnings.append(msg)


def walk(node, fn, path=()):
    fn(node, path)
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, fn, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, fn, path + (i,))


SUB_VAR = re.compile(r"\$\{([^}!][^}]*)\}")


def refs_in(node):
    """Conjunto de nomes referenciados (Ref, GetAtt, Sub) e condições (If/Condition)."""
    names, conds = set(), set()

    def visit(n, _p):
        if not isinstance(n, dict):
            return
        if "Ref" in n and isinstance(n["Ref"], str):
            names.add(n["Ref"])
        if "Fn::GetAtt" in n:
            names.add(n["Fn::GetAtt"][0])
        if "Fn::Sub" in n:
            v = n["Fn::Sub"]
            text, local = (v, {}) if isinstance(v, str) else (v[0], v[1] if len(v) > 1 else {})
            for var in SUB_VAR.findall(text):
                base = var.split(".")[0]
                if base not in local:
                    names.add(var if var.startswith("AWS::") else base)
        if "Fn::If" in n:
            conds.add(n["Fn::If"][0])
        if "Condition" in n and isinstance(n["Condition"], str) and len(n) == 1:
            conds.add(n["Condition"])

    walk(node, visit)
    return names, conds


def check_structure(tpl):
    params = tpl.get("Parameters", {}) or {}
    conditions = tpl.get("Conditions", {}) or {}
    resources = tpl.get("Resources", {}) or {}
    outputs = tpl.get("Outputs", {}) or {}
    globals_ = tpl.get("Globals", {}) or {}
    known = set(params) | set(resources) | PSEUDO

    used_params, used_conds = set(), set()
    sections = {"Globals": globals_, "Outputs": outputs, "Rules": tpl.get("Rules", {}) or {},
                "Conditions": conditions}
    for name, body in list(resources.items()) + [(f"<{k}>", v) for k, v in sections.items()]:
        names, conds = refs_in(body)
        for n in names:
            if n not in known:
                err(f"{name}: referência a '{n}' inexistente")
            if n in params:
                used_params.add(n)
        used_conds |= conds
        if isinstance(body, dict) and body.get("Condition") and name in resources:
            used_conds.add(body["Condition"])
    for oname, o in outputs.items():
        if o.get("Condition"):
            used_conds.add(o["Condition"])
    for c in used_conds:
        if c not in conditions:
            err(f"condição '{c}' usada mas não definida")
    for p in params:
        if p not in used_params:
            warn(f"parâmetro não usado: {p}")
    for c in conditions:
        if c not in used_conds:
            warn(f"condição não usada: {c}")

    # Recurso referenciando recurso condicional sem a mesma condição
    def guarded_refs(node, active=frozenset()):
        out = []
        if isinstance(node, dict):
            if "Fn::If" in node:
                cond, a, b = node["Fn::If"]
                out += guarded_refs(a, active | {cond})
                out += guarded_refs(b, active | {f"!{cond}"})
                return out
            n, _ = refs_in({k: v for k, v in node.items() if k in ("Ref", "Fn::GetAtt", "Fn::Sub")})
            out += [(x, active) for x in n]
            for k, v in node.items():
                if k not in ("Ref", "Fn::GetAtt", "Fn::Sub"):
                    out += guarded_refs(v, active)
        elif isinstance(node, list):
            for v in node:
                out += guarded_refs(v, active)
        return out

    def implies(owner_cond, tcond):
        """A condição do dono é igual à do alvo ou é um Fn::And que a inclui."""
        if owner_cond == tcond:
            return True
        body = conditions.get(owner_cond) if owner_cond else None
        if isinstance(body, dict) and isinstance(body.get("Fn::And"), list):
            return any(isinstance(x, dict) and x.get("Condition") == tcond for x in body["Fn::And"])
        return False

    def check_conditional_refs(owner, body, owner_cond):
        for target, active in guarded_refs(body):
            tcond = (resources.get(target) or {}).get("Condition")
            if tcond and not implies(owner_cond, tcond) and tcond not in active:
                err(f"{owner} (condição {owner_cond}) referencia {target} (condição {tcond})")

    for name, body in resources.items():
        check_conditional_refs(name, body.get("Properties", {}), body.get("Condition"))
        for dep in ([body["DependsOn"]] if isinstance(body.get("DependsOn"), str) else body.get("DependsOn", [])):
            tcond = (resources.get(dep) or {}).get("Condition")
            if tcond and not implies(body.get("Condition"), tcond):
                err(f"{name} DependsOn {dep} com condição diferente")
    for oname, o in outputs.items():
        check_conditional_refs(f"Output {oname}", o.get("Value"), o.get("Condition"))
    check_conditional_refs("Globals", globals_, None)

    # Nada de Action/Resource "*" em políticas de identidade
    def visit_iam(n, p):
        if isinstance(n, dict) and "Effect" in n and "Action" in n:
            actions = n["Action"] if isinstance(n["Action"], list) else [n["Action"]]
            res = n.get("Resource")
            res_list = res if isinstance(res, list) else [res]
            if n["Effect"] == "Allow" and ("*" in actions or "*" in res_list):
                err(f"IAM Allow com '*': {'/'.join(map(str, p))}")

    walk(resources, visit_iam)
    return params, conditions, resources


# ---------------------------------------------------------------------------
# IAM derivado do código Python
# ---------------------------------------------------------------------------
class Module:
    def __init__(self, name, path):
        self.name, self.path = name, path
        self.tree = ast.parse(open(path, encoding="utf-8").read())
        self.funcs = {n.name: n for n in self.tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        self.aliases = {}  # nome local -> (módulo, atributo|None)
        for n in self.tree.body:
            if isinstance(n, ast.ImportFrom):
                mod = n.module or ""
                if n.level:  # relativo dentro de common
                    mod = "common." + mod if mod else "common"
                for a in n.names:
                    target = f"{mod}.{a.name}" if mod in ("common",) else None
                    if mod == "common":
                        self.aliases[a.asname or a.name] = (f"common.{a.name}", None)
                    else:
                        self.aliases[a.asname or a.name] = (mod, a.name)
            elif isinstance(n, ast.Import):
                for a in n.names:
                    self.aliases[a.asname or a.name] = (a.name, None)


def load_modules(fdir):
    mods = {}
    for root, _, files in os.walk(fdir):
        if "__pycache__" in root:
            continue
        for f in files:
            if f.endswith(".py"):
                rel = os.path.relpath(os.path.join(root, f), fdir)[:-3].replace(os.sep, ".")
                if rel.endswith(".__init__"):
                    rel = rel[: -len(".__init__")]
                mods[rel] = Module(rel, os.path.join(root, f))
    return mods


TABLE_VARS = {"jobs_table": "Jobs", "users_table": "Users", "nonces_table": "Nonces"}
OP = {"get_item": "GetItem", "put_item": "PutItem", "delete_item": "DeleteItem", "query": "Query",
      "update_item": "UpdateItem", "scan": "Scan"}


def leaf_permissions(mod, fn_node):
    """Permissões diretas (sem seguir chamadas) de uma função."""
    perms = set()
    for n in ast.walk(fn_node):
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in TABLE_VARS:
            table = TABLE_VARS[f.value.id]
            op = OP.get(f.attr)
            if op == "Query":
                idx = next((k.value.value for k in n.keywords
                            if k.arg == "IndexName" and isinstance(k.value, ast.Constant)), None)
                # query(**kwargs) com "IndexName" num dict da própria função (ex.: _query_all):
                # a GSI vem dos chamadores (índice constante em _query_all(index_name=...), abaixo).
                via_kwargs = any(k.arg is None for k in n.keywords) and any(
                    isinstance(d, ast.Dict) and any(isinstance(dk, ast.Constant) and dk.value == "IndexName" for dk in d.keys)
                    for d in ast.walk(fn_node))
                if idx:
                    perms.add(("dynamodb:Query", f"{table}/index/{idx}"))
                elif not via_kwargs:
                    perms.add(("dynamodb:Query", table))
            elif op:
                perms.add((f"dynamodb:{op}", table + (":meta" if mod.name == "common.db" and fn_node.name.endswith("_meta") else "")))
        if isinstance(f, ast.Name) and f.id == "_query_all":
            idx = next((k.value.value for k in n.keywords
                        if k.arg == "index_name" and isinstance(k.value, ast.Constant)), None)
            if idx:
                perms.add(("dynamodb:Query", f"Jobs/index/{idx}"))
        if isinstance(f, ast.Attribute) and f.attr == "publish":
            perms.add(("sns:Publish", "AlertsTopic"))
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "s3":
            if f.attr == "generate_presigned_url":
                op = n.args[0].value if n.args and isinstance(n.args[0], ast.Constant) else "?"
                perms.add({"put_object": ("s3:PutObject", "reports/*"), "get_object": ("s3:GetObject", "reports/*")}[op])
            elif f.attr == "head_object":
                # sem s3:ListBucket o S3 devolve 403 em vez de 404 para chave ausente (PS-34)
                perms |= {("s3:GetObject", "reports/*"), ("s3:ListBucket", "bucket")}
            elif f.attr == "get_object":
                perms |= {("s3:GetObject", "*"), ("s3:GetObjectVersion", "*")}
            elif f.attr == "delete_object":
                perms |= {("s3:DeleteObject", "*"), ("s3:DeleteObjectVersion", "*")}
        if isinstance(f, ast.Name) and f.id == "get_secret" and n.args and isinstance(n.args[0], ast.Constant):
            perms.add(("ssm:GetParameter", f"env:{n.args[0].value}"))
    return perms


def env_reads(mod):
    """Variáveis de ambiente lidas no módulo: nome -> tem default?"""
    out = {}
    for n in ast.walk(mod.tree):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get":
            v = n.func.value
            if isinstance(v, ast.Attribute) and v.attr == "environ" and n.args and isinstance(n.args[0], ast.Constant):
                out[n.args[0].value] = len(n.args) > 1
    return out


def callees(mods, mod, fn_node):
    res = set()
    for n in ast.walk(fn_node):
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if isinstance(f, ast.Name):
            if f.id in mod.funcs:
                res.add((mod.name, f.id))
            elif f.id in mod.aliases:
                m, attr = mod.aliases[f.id]
                if attr and m in mods and attr in mods[m].funcs:
                    res.add((m, attr))
        elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in mod.aliases:
            m, attr = mod.aliases[f.value.id]
            target = m if attr is None else f"{m}.{attr}"
            if target in mods and f.attr in mods[target].funcs:
                res.add((target, f.attr))
    # decorators (handler) não adicionam permissões
    return res


def reachable(mods, start):
    seen, stack = set(), [start]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        m = mods[node[0]]
        stack.extend(callees(mods, m, m.funcs[node[1]]) - seen)
    return seen


def code_permissions(mods, handler):
    modname, fname = handler.split(".")
    if modname not in mods or fname not in mods[modname].funcs:
        return None, None
    nodes = reachable(mods, (modname, fname))
    perms = set()
    for m, f in nodes:
        perms |= leaf_permissions(mods[m], mods[m].funcs[f])
    used_mods = {m for m, _ in nodes} | {modname}
    return perms, used_mods


# ---------------------------------------------------------------------------
def resolve_resource(r, env):
    """Converte o Resource do template em rótulos comparáveis com os do código."""
    out = []
    for x in r if isinstance(r, list) else [r]:
        if isinstance(x, dict) and "Fn::GetAtt" in x:
            out.append({"JobsTable": "Jobs", "UsersTable": "Users", "NoncesTable": "Nonces",
                        "AsyncDlq": "AsyncDlq"}.get(x["Fn::GetAtt"][0], x["Fn::GetAtt"][0]))
        elif isinstance(x, dict) and "Ref" in x:
            out.append(x["Ref"])
        elif isinstance(x, dict) and "Fn::Sub" in x:
            s = x["Fn::Sub"] if isinstance(x["Fn::Sub"], str) else x["Fn::Sub"][0]
            m = re.match(r"\$\{(\w+)Table\.Arn\}/index/(.+)$", s)
            if m:
                out.append(f"{m.group(1)}/index/{m.group(2)}")
            elif ":parameter/" in s:
                out.append("param:" + s.split(":parameter")[1])
            elif ":s3:::proofsec-reports-" in s:
                if "/" not in s.split(":s3:::", 1)[1]:
                    out.append("bucket")  # ARN do bucket (s3:ListBucket)
                else:
                    out.append("reports" + ("/reports/*" if s.endswith("/reports/*") else "/*"))
            else:
                out.append(s)
        else:
            out.append(str(x))
    return out


def template_permissions(fn):
    props = fn.get("Properties", {})
    perms = set()
    for pol in props.get("Policies", []) or []:
        if not isinstance(pol, dict) or "Statement" not in pol:
            perms.add(("<managed/template>", str(pol)))
            continue
        for st in pol["Statement"]:
            cond_label = ""
            if isinstance(st, dict) and "Fn::If" in st:
                st = st["Fn::If"][1]
                cond_label = "?"
            if not isinstance(st, dict) or st.get("Effect") != "Allow":
                continue
            actions = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
            meta = bool(st.get("Condition"))
            for a in actions:
                for r in resolve_resource(st["Resource"], props.get("Environment", {})):
                    perms.add((a, r + (":meta" if meta and r == "Users" else "") + cond_label))
    return perms


def matches(code_perm, tpl_perms, env):
    action, res = code_perm
    for a, r in tpl_perms:
        r = r.rstrip("?")
        if a != action:
            continue
        if res.startswith("env:"):
            pname = env.get(res[4:])
            if isinstance(pname, dict) and "Fn::If" in pname:
                pname = pname["Fn::If"][1]
            if isinstance(pname, dict) and "Fn::Sub" in pname:
                pname = pname["Fn::Sub"]
            if pname and r == f"param:{pname}":
                return True
            continue
        if res in ("*",) and r in ("reports/*",):
            return True
        if res == "reports/*" and r in ("reports/reports/*", "reports/*"):
            return True
        if r == res:
            return True
        if r.endswith("/index/*") and res.startswith(r[:-1]):
            return True
        if res.endswith(":meta") and r == res:
            return True
    return False


def check_functions(tpl, fdir):
    mods = load_modules(fdir)
    resources = tpl["Resources"]
    genv = ((tpl.get("Globals", {}) or {}).get("Function", {}) or {}).get("Environment", {}).get("Variables", {})
    for name, res in resources.items():
        if res.get("Type") != "AWS::Serverless::Function":
            continue
        props = res["Properties"]
        runtime = props.get("Runtime", tpl["Globals"]["Function"].get("Runtime"))
        if not runtime.startswith("python"):
            continue
        handler = props["Handler"]
        perms, used_mods = code_permissions(mods, handler)
        if perms is None:
            err(f"{name}: handler {handler} não existe")
            continue
        env = {**genv, **(props.get("Environment", {}) or {}).get("Variables", {})}
        tperms = template_permissions(res)
        # 1) tudo que o código precisa está no template
        for p in sorted(perms):
            if p[0] == "sns:Publish" and not env.get("ALERT_TOPIC_ARN"):
                continue
            if not matches(p, tperms, env):
                if p[0] == "ssm:GetParameter" and not env.get(p[1][4:]):
                    warn(f"{name}: código lê {p[1]} mas a env não está definida (usa fallback)")
                else:
                    err(f"{name} ({handler}): falta permissão {p}")
        # 2) nada além do necessário (exceto DLQ do EventInvokeConfig)
        for a, r in sorted(tperms):
            if a == "sqs:SendMessage" and r == "AsyncDlq":
                if not props.get("EventInvokeConfig", {}).get("DestinationConfig"):
                    err(f"{name}: sqs:SendMessage sem DestinationConfig")
                continue
            needed = any(matches(p, {(a, r)}, env) for p in perms)
            if not needed:
                err(f"{name} ({handler}): permissão sobrando {a} {r}")
        # 3) env vars sem default lidas pelos módulos usados
        for m in used_mods | {"common.db", "common.http", "common.log"}:
            if m not in mods:
                continue
            for var, has_default in env_reads(mods[m]).items():
                if var not in env and not has_default:
                    err(f"{name}: módulo {m} lê {var} sem default e a env não define")


def check_routes(tpl):
    resources = tpl["Resources"]
    routes = set()
    for name, res in resources.items():
        for ev in (res.get("Properties", {}).get("Events", {}) or {}).values():
            if ev.get("Type") == "HttpApi":
                p = ev["Properties"]
                routes.add(f"{p['Method'].upper()} {p['Path']}")
    for name, res in resources.items():
        if res.get("Type") == "AWS::Serverless::HttpApi":
            for key in (res["Properties"].get("RouteSettings") or {}):
                if key not in routes:
                    err(f"RouteSettings '{key}' não corresponde a nenhuma rota")
    return routes


def main():
    path = sys.argv[1]
    fdir = None
    if "--functions-dir" in sys.argv:
        fdir = sys.argv[sys.argv.index("--functions-dir") + 1]
    tpl = load(path)
    check_structure(tpl)
    routes = check_routes(tpl)
    if fdir:
        check_functions(tpl, fdir)
    print(f"rotas: {len(routes)} | recursos: {len(tpl['Resources'])}")
    for w in warnings:
        print("AVISO:", w)
    for p in problems:
        print("ERRO:", p)
    print("OK" if not problems else f"{len(problems)} erro(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
