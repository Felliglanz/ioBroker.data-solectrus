# Changelog

## 0.2.0 - 2026-01-29

### Added

- Formula function `pow(a, b)` (use this instead of an exponent operator).
- One-time debug logs for blocked dangerous input keys and for skipped JSONPath when the source value is already numeric.

### Changed

- Security hardening: formula input variables use a null-prototype map and block dangerous keys (`__proto__`, `prototype`, `constructor`).
- Expression engine: removed support for `**` and for loose equality operators `==` / `!=` (use `===` / `!==`).
- Bounded internal "log once" caches to avoid unbounded growth.

## 0.1.22 - 2026-01-28

### Added

- Optional JSON extraction for `source` items and formula inputs via **JSONPath (optional)** (e.g. `$.apower`, `$.aenergy.by_minute[2]`).

### Changed

- Wiki/README updated: JSON payloads no longer require a separate alias/script when JSONPath is configured.
- When `Datatype` is set to `boolean` or `string`, the adapter now writes real booleans/strings to the output state (not 0/1).

### Notes

- JSONPath support is intentionally limited (dot access, bracket keys, array indexes). Unsupported expressions fall back to `0` and log a warning once.
