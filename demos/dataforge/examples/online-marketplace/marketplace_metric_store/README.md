# marketplace_metric_store

The metric store for the online-marketplace example. `forge-init` scans this
tree to discover the domain taxonomy, the entity folder structure, and the
naming conventions — none of it is declared in the manifest.

## Layout

```
marketplace_metric_store/
  common/                      # runners and shared config (not a domain)
  fulfilment/                  # domain
    Order/                     # entity
      Code/                    # pipelines, one file per cadence
      Schema/                  # table DDL, one file per grain and cadence
      Schema/Alter/            # column additions to existing tables
      README.md                # metric inventory and development history
    Dispatch/                  # 48-hour dispatch promise entity
      Code/
      Schema/
      README.md
```

## Key numbers

| | |
| --- | --- |
| Domains | 1 (`fulfilment`) |
| Entities built | 2 (`Order`, `Dispatch`) |
| Metrics | 4 (`place`, `cancel`, `meet`, `miss`) |
| Grains | 1 (`merchant_id`) |
| Cadences | 2 (Daily, Cumulative) |
| Tables | 4 (2 per entity) |
| Zones | 2 (`east`, `west`) |
| In progress | None |

## Conventions

Metric columns are `total_{entity}_{verb}_count`. System columns
(`SNAPSHOT_DATE`, `LOAD_TIMESTAMP`, `SOURCE_ZONE`) are uppercase; everything
else is `lowercase_snake_case`. Table names are
`{Entity}_{Grain}_Metrics_Snapshot_{Cadence}`.

`forge-lint` enforces all of the above. The rules live in the skill, the
vocabulary they are applied to comes from the resolved manifest.
