import type { FieldDef } from "../../lib/scenarios"

interface Props {
  fields: ReadonlyArray<FieldDef>
  values: Record<string, string | number | boolean>
  onChange: (values: Record<string, string | number | boolean>) => void
}

const inputStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--sl-color-gray-5)",
  backgroundColor: "var(--sl-color-bg)",
  color: "var(--sl-color-text)",
  fontSize: "0.9rem",
  width: "100%",
  fontFamily: "var(--sl-font-system-mono)",
}

export function ParameterEditor({ fields, values, onChange }: Props) {
  const update = (name: string, raw: string, type: FieldDef["type"]) => {
    let parsed: string | number | boolean = raw
    if (type === "number") parsed = Number(raw) || 0
    if (type === "boolean") parsed = raw === "true"
    onChange({ ...values, [name]: parsed })
  }

  return (
    <div>
      <span
        style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}
      >
        Entity Attributes
      </span>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
          gap: "0.5rem",
        }}
      >
        {fields.map((f) => (
          <div key={f.name}>
            <label
              htmlFor={`field-${f.name}`}
              style={{
                display: "block",
                fontSize: "0.75rem",
                fontWeight: 600,
                marginBottom: "0.125rem",
              }}
            >
              {f.name}{" "}
              <span style={{ fontWeight: 400, color: "var(--sl-color-gray-3)" }}>({f.type})</span>
            </label>
            {f.type === "boolean" ? (
              <select
                id={`field-${f.name}`}
                style={inputStyle}
                value={String(values[f.name])}
                onChange={(e) => update(f.name, e.target.value, f.type)}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                id={`field-${f.name}`}
                type={f.type === "number" ? "number" : "text"}
                style={inputStyle}
                value={String(values[f.name] ?? "")}
                onChange={(e) => update(f.name, e.target.value, f.type)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
