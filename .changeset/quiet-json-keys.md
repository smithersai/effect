---
"effect": patch
---

Preserve Schema.Json's required readonly decoded and encoded key metadata through annotation, checks and rebuilds. The concrete JsonValueSchema interface remains a subtype of Codec<Json> and retains its other public views. Runtime validation is unchanged.
