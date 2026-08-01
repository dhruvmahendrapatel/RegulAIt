#!/usr/bin/env python3
"""
Derive a Drizzle schema from the EF Core DataContext of regulAIt Authorized.

The EF mapping is fully explicit (ToTable / HasColumnName / HasKey / HasIndex /
HasMaxLength), so the table and column shape can be read straight off it rather
than guessed. CLR nullability comes from the entity classes.

Emits one module per Postgres schema plus a relations module.
"""
import re, os, sys, json, collections

ROOT = sys.argv[1]
MODELS = os.path.join(ROOT, "Models")
CTX = os.path.join(MODELS, "DataContext.cs")
OUT = sys.argv[2]

# ---------------------------------------------------------------- entity CLR types
PROP = re.compile(r'^\s+public\s+(?:virtual\s+)?([A-Za-z0-9_<>?\[\]]+)\s+(\w+)\s*\{', re.M)
NAV = re.compile(r'^(ICollection|List|IEnumerable)<')
entities = {}
for f in os.listdir(MODELS):
    if not f.endswith(".cs") or f in ("DataContext.cs",):
        continue
    src = open(os.path.join(MODELS, f), encoding="utf-8-sig", errors="surrogateescape").read()
    m = re.search(r'public\s+partial\s+class\s+(\w+)', src)
    if not m:
        continue
    props = {}
    for clr, name in PROP.findall(src):
        props[name] = clr
    entities[m.group(1)] = props

# ---------------------------------------------------------------- DataContext blocks
ctx = open(CTX, encoding="utf-8-sig", errors="surrogateescape").read()
BLOCK = re.compile(r'modelBuilder\.Entity<(\w+)>\(entity =>\s*\{(.*?)\n        \}\);', re.S)

RE_TABLE = re.compile(r'\.ToTable\("([^"]+)"(?:\s*,\s*"([^"]+)")?\)')
RE_KEY = re.compile(r'\.HasKey\(e => e\.(\w+)\)')
RE_IDX = re.compile(r'\.HasIndex\(e => (?:new \{([^}]*)\}|e\.(\w+))\s*,\s*"([^"]+)"\)')
RE_PROPBLK = re.compile(r'entity\.Property\(e => e\.(\w+)\)(.*?);', re.S)
RE_COLNAME = re.compile(r'\.HasColumnName\("([^"]+)"\)')
RE_MAXLEN = re.compile(r'\.HasMaxLength\((\d+)\)')
RE_COLTYPE = re.compile(r'\.HasColumnType\("([^"]+)"\)')
RE_FK = re.compile(r'\.HasOne\(d => d\.(\w+)\)\s*\.WithMany\([^)]*\)\s*\.HasForeignKey\(d => d\.(\w+)\)', re.S)

def camel(s):
    """PascalCase (or Snake_Mixed, as a handful of EF properties are) -> camelCase."""
    parts = [p for p in s.split("_") if p]
    if not parts:
        return s
    head = parts[0][0].lower() + parts[0][1:]
    return head + "".join(p[0].upper() + p[1:] for p in parts[1:])

def ts_ident(s):
    s = camel(s)
    return s if re.match(r'^[A-Za-z_$][\w$]*$', s) else f'"{s}"'

# `Import` and `Function` are real entity names here, and both camel-case into
# TypeScript reserved words. Suffix those so the module still parses.
RESERVED = {
    "import", "export", "function", "class", "const", "let", "var", "return",
    "default", "delete", "new", "typeof", "instanceof", "in", "of", "do", "if",
    "else", "for", "while", "switch", "case", "break", "continue", "this",
    "super", "void", "with", "yield", "await", "enum", "extends", "implements",
    "interface", "package", "private", "protected", "public", "static", "null",
    "true", "false", "try", "catch", "finally", "throw", "debugger",
}

def table_var(entity):
    name = camel(entity)
    return f"{name}Table" if name in RESERVED else name

tables = []
for ent, body in BLOCK.findall(ctx):
    mt = RE_TABLE.search(body)
    if not mt:
        continue                                    # keyless / not mapped
    table, schema = mt.group(1), mt.group(2) or "public"
    pk = RE_KEY.search(body)
    pk = pk.group(1) if pk else None

    cols, order = {}, []
    for prop, tail in RE_PROPBLK.findall(body):
        cn = RE_COLNAME.search(tail)
        if not cn:
            continue
        ml = RE_MAXLEN.search(tail)
        ct = RE_COLTYPE.search(tail)
        cols[prop] = {
            "col": cn.group(1),
            "max": int(ml.group(1)) if ml else None,
            "coltype": ct.group(1) if ct else None,
            "required": ".IsRequired()" in tail,
            "novalgen": ".ValueGeneratedNever()" in tail,
        }
        order.append(prop)

    idx = []
    for grouped, single, name in RE_IDX.findall(body):
        props = [p.strip().split(".")[-1] for p in grouped.split(",")] if grouped else [single]
        idx.append({"name": name, "props": props})

    fks = [{"nav": n, "prop": p} for n, p in RE_FK.findall(body)]

    tables.append({"entity": ent, "table": table, "schema": schema, "pk": pk,
                   "cols": cols, "order": order, "idx": idx, "fks": fks})

# ---------------------------------------------------------------- CLR -> Drizzle
def drizzle_col(prop, meta, clr, is_pk):
    col = meta["col"]
    nullable = clr.endswith("?")
    base = clr.rstrip("?")
    ctype = meta["coltype"]

    if ctype == "jsonb":
        expr, imp = f'jsonb("{col}")', "jsonb"
    elif ctype and "[]" in ctype:
        m = re.match(r'character varying\((\d+)\)\[\]', ctype)
        n = m.group(1) if m else None
        expr = f'varchar("{col}"{{ length: {n} }}).array()' if n else f'text("{col}").array()'
        expr = f'varchar("{col}", {{ length: {n} }}).array()' if n else f'text("{col}").array()'
        imp = "varchar" if n else "text"
    elif base == "string":
        if meta["max"]:
            expr, imp = f'varchar("{col}", {{ length: {meta["max"]} }})', "varchar"
        else:
            expr, imp = f'text("{col}")', "text"
        # C# nullable-refs are off, so `string` is ambiguous; treat as nullable
        # unless EF marked it required or it is the key.
        nullable = not (meta["required"] or is_pk)
    elif base == "int":
        expr, imp = f'integer("{col}")', "integer"
    elif base == "long":
        expr, imp = f'bigint("{col}", {{ mode: "number" }})', "bigint"
    elif base == "bool":
        expr, imp = f'boolean("{col}")', "boolean"
    elif base == "DateTime":
        expr, imp = f'timestamp("{col}", {{ withTimezone: false, mode: "date" }})', "timestamp"
    elif base == "decimal":
        expr, imp = f'numeric("{col}")', "numeric"
    elif base == "Guid":
        expr, imp = f'uuid("{col}")', "uuid"
    elif base in ("byte[]",):
        expr, imp = f'customType("{col}")', "text"
    elif base.startswith("List<") or base.startswith("ICollection<"):
        return None, None
    else:
        expr, imp = f'text("{col}")', "text"      # unmapped CLR type -> text

    if is_pk:
        # Integer keys are identity-by-default in this database unless EF pinned
        # them with ValueGeneratedNever. String keys (job_locks.lock_key,
        # risk_description.risk_id) are natural keys and never generated.
        generated = base in ("int", "long") and not meta["novalgen"]
        expr += ".primaryKey().generatedByDefaultAsIdentity()" if generated else ".primaryKey()"
    elif not nullable:
        expr += ".notNull()"
    return expr, imp

by_schema = collections.defaultdict(list)
for t in tables:
    by_schema[t["schema"]].append(t)

os.makedirs(OUT, exist_ok=True)
stats = collections.Counter()

for schema, tabs in sorted(by_schema.items()):
    imports, lines = set(), []
    if schema != "public":
        lines.append(f'export const {schema}Schema = pgSchema("{schema}");\n')
    for t in sorted(tabs, key=lambda x: x["table"]):
        props = entities.get(t["entity"], {})
        maker = "pgTable" if schema == "public" else f"{schema}Schema.table"
        if schema == "public":
            imports.add("pgTable")
        else:
            imports.add("pgSchema")
        body = []
        for prop in t["order"]:
            clr = props.get(prop)
            if not clr or NAV.match(clr):
                continue
            expr, imp = drizzle_col(prop, t["cols"][prop], clr, prop == t["pk"])
            if not expr:
                continue
            imports.add(imp)
            body.append(f'  {ts_ident(prop)}: {expr},')
            stats["columns"] += 1
        if not body:
            continue
        extra = ""
        if t["idx"]:
            imports.add("index")
            ent = []
            for i in t["idx"]:
                on = ", ".join(f't.{ts_ident(p)}' for p in i["props"] if p in t["cols"])
                if on:
                    ent.append(f'  index("{i["name"]}").on({on}),')
                    stats["indexes"] += 1
            if ent:
                extra = "\n}, (t) => [\n" + "\n".join(ent) + "\n]"
        lines.append(
            f'export const {table_var(t["entity"])} = {maker}("{t["table"]}", {{\n'
            + "\n".join(body) + ("\n" + extra.lstrip("\n") if extra else "\n}") + ");\n"
        )
        stats["tables"] += 1

    hdr = (
        "// GENERATED from the regulAIt Authorized EF Core DataContext.\n"
        "// Regenerate with scripts/gen-authorized-schema.py; do not hand-edit.\n"
        f"// Postgres schema: {schema}\n\n"
        f'import {{ {", ".join(sorted(i for i in imports if i))} }} from "drizzle-orm/pg-core";\n\n'
    )
    open(os.path.join(OUT, f"{schema}.ts"), "w", encoding="utf-8").write(hdr + "\n".join(lines))

names = sorted(by_schema)
open(os.path.join(OUT, "index.ts"), "w", encoding="utf-8").write(
    "// GENERATED — regulAIt Authorized schema, one module per Postgres schema.\n\n"
    + "\n".join(f'export * from "./{n}.js";' for n in names) + "\n"
)

print(json.dumps({"tables": stats["tables"], "columns": stats["columns"],
                  "indexes": stats["indexes"],
                  "schemas": {k: len(v) for k, v in sorted(by_schema.items())}}, indent=2))
