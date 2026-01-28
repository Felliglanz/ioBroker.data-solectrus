# SoC aus mehreren Speichern (gewichtet) berechnen

Wenn du mehrere Batteriespeicher hast, ist ein „Gesamt-SoC“ als einfacher Mittelwert oft falsch.

Beispiel: Ein kleiner Speicher mit 10% und ein großer Speicher mit 90% – der echte Gesamtfüllstand hängt davon ab, **wie groß** die Speicher sind.

Die saubere Lösung ist ein **gewichteter Mittelwert** nach Kapazität.

## Grundidee

- Jeder Speicher $i$ hat einen SoC in %: $SOC_i$ (0–100)
- Jeder Speicher hat eine Kapazität $C_i$ (z.B. in kWh)

Dann:

$$
SOC_{gesamt} = 100 \cdot \frac{\sum (C_i \cdot SOC_i/100)}{\sum C_i}
$$

## Konfiguration im Adapter

### Inputs

Lege ein Item im Modus `formula` an und trage die SoC-States als Inputs ein:

- `soc1` → SoC Speicher 1 (%)
- `soc2` → SoC Speicher 2 (%)
- `soc3` → SoC Speicher 3 (%)
- `soc4` → SoC Speicher 4 (%)

### Beispiel-Formel (wie in deinem Beispiel)

Angenommen, die Kapazitäten sind:

- Speicher 1: `0.96`
- Speicher 2: `1.92`
- Speicher 3: `1.92`
- Speicher 4: `1.92`
- Summe: `6.72`

Dann ist die Formel:

```
100 * (
  (0.96 * (soc1 / 100)) +
  (1.92 * (soc2 / 100)) +
  (1.92 * (soc3 / 100)) +
  (1.92 * (soc4 / 100))
) / 6.72
```

### Erklärung in Worten

- `socX / 100` macht aus Prozent (z.B. 55) einen Anteil (0.55).
- Jede Batterie wird mit ihrer Kapazität gewichtet (`0.96`, `1.92`, …).
- Durch Division durch die Gesamtkapazität (`6.72`) bekommst du den gewichteten Durchschnitt.
- `* 100` macht daraus wieder Prozent.

## Praxis-Tipps

- **Einheit**: `%`
- **Clamp result**: Min = `0`, Max = `100` (oder nutze `clamp(...)` in der Formel)
- Wenn einzelne SoC-States manchmal `null`/leer sind, sorge upstream für sinnvolle Defaults (oder nutze getrennte Items je nach Datenquelle).

## Alternative: Formel kompakter

Wenn du viele Speicher hast, kannst du die Formel auch in „Zähler / Nenner“ strukturieren:

```
100 * (
  0.96*(soc1/100) + 1.92*(soc2/100) + 1.92*(soc3/100) + 1.92*(soc4/100)
) / (0.96 + 1.92 + 1.92 + 1.92)
```

Das ist leichter wartbar, wenn sich mal eine Kapazität ändert.
