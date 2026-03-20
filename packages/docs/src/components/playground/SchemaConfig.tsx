import type { Casing } from "../../lib/playground-engine"

interface Props {
  value: { name: string; version: number; casing: Casing }
  onChange: (value: { name: string; version: number; casing: Casing }) => void
}

const inputStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--sl-color-gray-5)",
  backgroundColor: "var(--sl-color-bg)",
  color: "var(--sl-color-text)",
  fontSize: "0.9rem",
  width: "100%",
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  fontWeight: 600,
  marginBottom: "0.125rem",
}

export function SchemaConfig({ value, onChange }: Props) {
  return (
    <div>
      <span
        style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.25rem" }}
      >
        Schema Config
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 4rem 6rem", gap: "0.5rem" }}>
        <div>
          <label htmlFor="schema-name" style={labelStyle}>
            Name
          </label>
          <input
            id="schema-name"
            style={inputStyle}
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="schema-version" style={labelStyle}>
            Ver
          </label>
          <input
            id="schema-version"
            type="number"
            min={1}
            style={inputStyle}
            value={value.version}
            onChange={(e) => onChange({ ...value, version: Number(e.target.value) || 1 })}
          />
        </div>
        <div>
          <label htmlFor="schema-casing" style={labelStyle}>
            Casing
          </label>
          <select
            id="schema-casing"
            style={inputStyle}
            value={value.casing}
            onChange={(e) => onChange({ ...value, casing: e.target.value as Casing })}
          >
            <option value="lowercase">lower</option>
            <option value="uppercase">upper</option>
            <option value="preserve">preserve</option>
          </select>
        </div>
      </div>
    </div>
  )
}
