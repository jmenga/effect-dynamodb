import type { Scenario } from "../../lib/scenarios"

interface Props {
  scenarios: ReadonlyArray<Scenario>
  selectedIndex: number
  onChange: (index: number) => void
}

export function ScenarioSelector({ scenarios, selectedIndex, onChange }: Props) {
  return (
    <div>
      <label
        htmlFor="scenario-select"
        style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.25rem" }}
      >
        Scenario
      </label>
      <select
        id="scenario-select"
        value={selectedIndex}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          padding: "0.5rem",
          borderRadius: "0.375rem",
          border: "1px solid var(--sl-color-gray-5)",
          backgroundColor: "var(--sl-color-bg)",
          color: "var(--sl-color-text)",
          fontSize: "0.9rem",
        }}
      >
        {scenarios.map((s, i) => (
          <option key={s.name} value={i}>
            {s.name} — {s.description}
          </option>
        ))}
      </select>
    </div>
  )
}
