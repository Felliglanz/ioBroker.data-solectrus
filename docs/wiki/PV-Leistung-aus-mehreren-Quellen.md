# PV-Leistung aus mehreren Quellen summieren

Viele Setups haben mehr als einen PV-Wert:

- Wechselrichter 1
- Wechselrichter 2
- Balkonkraftwerk (BKW)
- Batterie-Wechselrichter mit PV-Eingang

Damit SOLECTRUS & Co. nicht „mehrere PVs“ verstehen müssen, rechnest du dir einfach eine Gesamt-PV.

## Item: pv.power

- **Folder/Group**: `pv`
- **Target ID**: `power`
- **Mode**: `formula`
- **Inputs**:
  - `wr1` → PV Leistung WR1 (W)
  - `wr2` → PV Leistung WR2 (W)
  - `bkw` → PV Leistung BKW (W)
- **Formula expression**:

```
max(0, wr1) + max(0, wr2) + max(0, bkw)
```

- **Unit**: `W`

## Hinweise

- Achte darauf, dass alle Quellen dieselbe Einheit haben (W vs. kW).
- Wenn eine Quelle gelegentlich negativ meldet (Messfehler), verhindert `max(0, …)` „PV < 0“.
- Wenn eine Quelle zeitweise `0` oder `null` liefert, prüfe im ioBroker-Objekt, ob wirklich Zahlen ankommen.
