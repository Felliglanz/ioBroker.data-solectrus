# PV-Überschuss & Eigenverbrauch

Zwei sehr praktische Kennzahlen für Automatisierung und Visualisierung:

- **PV-Überschussleistung**: Wie viel PV ist „übrig“, nachdem das Haus versorgt ist?
- **Eigenverbrauch (Leistung)**: Wie viel der PV wird gerade direkt im Haus genutzt?

Das ist nützlich für:

- Verbraucher per Regel/Automation starten (z.B. Boiler, Wallbox)
- Anzeige von „Eigenverbrauch“ im Dashboard

## Voraussetzungen

Du brauchst mindestens:

- `pv` = PV-Leistung (W, positiv)
- `house` = Hausverbrauch (W, positiv)

Falls du `house` noch nicht hast, siehe Use-Case „Hausverbrauch berechnen“.

## Item 1: pv.surplus_power (Überschuss)

- **Folder/Group**: `pv`
- **Target ID**: `surplus_power`
- **Mode**: `formula`
- **Inputs**: `pv`, `house`

Formel:

```
max(0, pv - house)
```

## Item 2: pv.self_consumption_power (Eigenverbrauchsleistung)

Das ist der Anteil der PV, der gerade direkt genutzt wird (also begrenzt durch den kleineren Wert).

Formel:

```
min(pv, house)
```

## Optional: Eigenverbrauchsquote in %

Wenn du eine Prozentzahl möchtest (nur sinnvoll, wenn PV > 0):

- **Target ID**: `self_consumption_percent`
- **Unit**: `%`

Formel:

```
pv > 0 ? (100 * min(pv, house) / pv) : 0
```

Hinweis: Prozentwerte sind Momentaufnahmen. Für „Tages-Eigenverbrauchsquote“ brauchst du Energie (kWh) über Zeit.
