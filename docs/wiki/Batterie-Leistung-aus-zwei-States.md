# Batterie-Leistung aus zwei States (Laden/Entladen)

Manche Systeme liefern Batterie-Leistung nicht als einen „signed“ Wert, sondern getrennt:

- `outputPower` (Entladen)
- `inputPower` (Laden)

Damit kannst du dir in data-solectrus drei sinnvolle Werte bauen:

- Netto (signed): Entladen positiv, Laden negativ
- Entladen (nur positiv)
- Laden (nur positiv)

## Variante 1: Netto-Leistung (signed)

### Item: battery.power

- **Folder/Group**: `battery`
- **Target ID**: `power`
- **Mode**: `formula`
- **Inputs**:
  - `out` → outputPower (W)
  - `in` → inputPower (W)

Formel:

```
out - in
```

Ergebnis:

- positiv = Batterie entlädt
- negativ = Batterie lädt

## Variante 2: getrennt in Laden/Entladen

### Item: battery.discharge_power

```
max(0, out - in)
```

### Item: battery.charge_power

```
max(0, in - out)
```

## Tipps

- Wenn du beide Richtungen getrennt hast, kannst du viele andere Formeln einfacher bauen (z.B. Hausverbrauch-Bilanz).
- „Clamp negative to 0“ ist hier meistens nicht nötig, weil `max(0, …)` das schon erledigt.
