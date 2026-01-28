# Hausverbrauch berechnen

„Hausverbrauch“ ist der Verbrauch der Verbraucher im Haus (also das, was *wirklich* in Geräte/Beleuchtung/Heizung etc. fließt) – nicht unbedingt das, was PV/Netz/Batterie gerade machen.

In einem typischen Energieschema gilt (mit **positiven** Richtungsgrößen):

- PV erzeugt `pv`
- Netzbezug `grid_import`
- Netzeinspeisung `grid_export`
- Batterie entlädt `batt_discharge`
- Batterie lädt `batt_charge`

Dann ist die Bilanz:

$$
\text{HouseLoad} = pv + grid\_import + batt\_discharge - grid\_export - batt\_charge
$$

## Variante A (empfohlen): mit Richtungs-Inputs (Import/Export, Laden/Entladen)

### Item: house_power

- **Folder/Group**: `house`
- **Target ID**: `power`
- **Mode**: `formula`
- **Inputs**:
  - `pv` → PV-Leistung (W)
  - `grid_import` → Netzbezug (W, nur positiv)
  - `grid_export` → Einspeisung (W, nur positiv)
  - `batt_discharge` → Batterie-Entladen (W, nur positiv)
  - `batt_charge` → Batterie-Laden (W, nur positiv)
- **Formula expression**:

```
pv + grid_import + batt_discharge - grid_export - batt_charge
```

- **Clamp result**: Min = `0` (damit keine negativen Restwerte angezeigt werden)
- **Unit**: `W`

### Quick-Checks

- Nachts ohne PV: `pv ≈ 0`, dann sollte `house_power ≈ grid_import + batt_discharge - batt_charge` sein.
- Mittags mit PV-Überschuss: `grid_export > 0`, dann sinkt `house_power` nicht, sondern bleibt „echter Verbrauch“.

## Variante B: du hast nur „signed“ States (ein State mit Vorzeichen)

Viele Systeme liefern stattdessen:

- `grid_signed`: Netzleistung (Import positiv, Export negativ) **oder umgekehrt**
- `batt_signed`: Batterieleistung (Entladen positiv, Laden negativ) **oder umgekehrt**

Wenn (und nur wenn) deine Vorzeichen so sind:

- Netzbezug = positiv
- Einspeisung = negativ
- Batterie entlädt = positiv
- Batterie lädt = negativ

…dann kannst du den Hausverbrauch sehr einfach rechnen:

```
house = pv + grid_signed + batt_signed
```

Wenn deine Vorzeichen andersherum sind, musst du die Werte invertieren oder in Import/Export auftrennen.

### Sicherer Ansatz: auftrennen

```
grid_import  = max(0,  grid_signed)
grid_export  = max(0, -grid_signed)
charge       = max(0, -batt_signed)
discharge    = max(0,  batt_signed)

house = pv + grid_import + discharge - grid_export - charge
```

Tipp: Lege `grid_import`, `grid_export`, `charge`, `discharge` als eigene Items an (oder rechne es in einer Formel direkt), dann wird alles transparenter.
