# Appmixer Flow Authoring Guide

How to write a valid Appmixer flow descriptor JSON (the `flow` body of `POST /flows`).

## 1. Descriptor Structure

A flow is a **flat JSON object**: each key is a **unique component ID (UUID v4)**, each value is a component descriptor. There is no array, no ordering — wiring is expressed per-component via `source`.

```json
{
  "<component-uuid-1>": { ...component descriptor... },
  "<component-uuid-2>": { ...component descriptor... }
}
```

### Component descriptor keys (flow-schema.json)

The component descriptor schema has `additionalProperties: false` — only these keys are allowed:

| Key | Required | Type / constraint |
|-----|----------|-------------------|
| `type` | **yes** (only required key) | String matching `^\w+\.\w+\.\w+\.\w+$`, i.e. `appmixer.<service>.<module>.<ComponentName>` (e.g. `appmixer.utils.timers.Scheduler`) |
| `label` | recommended | String; display name shown in Studio |
| `source` | yes in practice | Object; incoming connections. `{}` for triggers |
| `config` | yes in practice | Object (or null); allows `properties`, `auth`, `transform`. `{}` if unused |
| `x`, `y` | optional | Numbers; canvas position in pixels |
| `version` | optional | String, e.g. `"1.0.0"` |
| `errorHandling` | optional | Object; see Error Handling. Never change/remove an existing one unless asked |
| `manifest` | optional | Any (schema leaves it unconstrained) |

**You do not have to generate the IDs yourself.** `create_flow` and `update_flow` accept
readable placeholder keys (`"trigger"`, `"send_email"`) for components that do not exist yet:
each one gets a freshly minted UUID and every reference to it — `source` entries and
`$.<id>.…` variable paths — is rewritten to match. The response returns the mapping in
`componentIds`. Keys that already are UUIDs are never re-minted, so editing an existing flow
keeps component identity intact. Use placeholders consistently within one call: the same
string everywhere for the same component.

**Component IDs must be UUIDs** (e.g. `"a1b2c3d4-e5f6-7890-abcd-ef1234567890"`, `crypto.randomUUID()`), never readable slugs like `"create-project"`. Readable/reused IDs break OAuth account connection: the engine resolves a component's required auth scopes by a **global** componentId lookup that ignores the flowId, so reused IDs bind to the wrong flow and the authorize URL ships with wrong/empty scopes. Never reuse an ID within a flow either.

Component types follow `appmixer.<service>.<module>.<ComponentName>`, e.g. `appmixer.utils.controls.OnStart`, `appmixer.slack.messages.SendMessage`, `appmixer.utils.http.Post`. Never invent component type names — discover them via tools.

## 2. Wiring: the `source` Field

`source` defines **incoming connections**: which upstream component's output port feeds which input port of this component.

```json
"source": {
  "<this-component-inPort>": {
    "<upstream-component-uuid>": ["<upstream-output-port>"]
  }
}
```

Rules:

- **Triggers** (components that start the flow — Timer, Scheduler, WebhookTrigger, OnStart, app triggers) have **`"source": {}`** — no incoming connections. A flow has exactly ONE trigger.
- **Actions** must have a `source` connecting them to an upstream component.
- Most actions have a single inPort named `in`, but **not all** — some components use different inPort names (e.g. salesforce CreateLead uses `lead`). The `source` (and `config.transform`) key must be the component's **real inPort name**.
- The value per upstream UUID is an array of that component's **real output port names** (per schema also a plain string is accepted; the array form with `uniqueItems`, `minItems: 1` is the convention).
- Fan-in: list multiple upstream UUIDs under the same inPort to receive from several components.
- **Not every inPort accepts fan-in.** An inPort with `"maxConnections": 1` in the component
  manifest takes exactly one incoming connection (in `appmixer.utils` this is
  `controls.Each`, `controls.SetVariable`, `controls.MockValue` and `controls.Testing`).
  To merge two branches into such a component, wire both into
  `appmixer.utils.controls.Join` (inPort `in`, outPort `out`) and connect `Join` to it.
  Check `maxConnections` on the target inPort before planning a fan-in.
- Port names are exact: `greater` not `pass`, `weather` not `out`, `request` for WebhookTrigger, `response` for HTTP actions, `item`/`done` for Each.
- The virtual **`error`** port: every component implicitly has an `error` output port (it is NOT listed in the component's outPorts / tool results). Wire to it like any port: `"source": { "in": { "<failing-uuid>": ["error"] } }` — see Error Handling.

## 3. Configuration: the `config` Field

`config` allows three sub-keys: `properties`, `transform`, `auth`.

### 3a. `config.properties` — static component config

Values for the component's top-level **properties** (design-time, not wired from upstream). Typical for trigger configuration and fixed IDs:

```json
"config": { "properties": { "minute": "0", "hour": "9", "dayMonth": "*", "month": "*", "dayWeek": "*", "timezone": "UTC" } }
```

Other examples: Timer `{ "interval": 60 }` (minutes), Airtable `{ "baseId": "appXXX", "tableIdOrName": "tblYYY" }`. Where a field goes is determined by the component definition: fields defined in the component's top-level `properties` → `config.properties`; fields defined on `inPorts` → `config.transform`. `config.properties` is never used for data mapping.

### 3b. `config.transform` — per-inPort input mapping

Maps upstream output data into this component's input fields. Its structure **mirrors `source`**: same inPort key, same upstream UUID, same output port name.

```json
"config": {
  "transform": {
    "<this-inPort>": {
      "<upstream-component-uuid>": {
        "<upstream-output-port>": {
          "type": "json2new",
          "modifiers": {
            "<field1>": {
              "<modifier-uuid>": {
                "variable": "$.<upstream-uuid>.<port>.<field>",
                "functions": []
              }
            }
          },
          "lambda": {
            "<field1>": "{{{<modifier-uuid>}}}",
            "<field2>": "<static value>"
          }
        }
      }
    }
  }
}
```

- **`"type": "json2new"` always** — no other transform type is valid.
- `lambda` maps each input field to either a **static value** (`"Prague"`, `true`, `42`) or a **variable placeholder** `"{{{<modifier-uuid>}}}"`.
- Include only relevant fields; all fields listed in the inPort schema's `required` must appear in `lambda`.
- Only include `config.transform` when the component actually receives data from upstream.

### 3c. Variable references (the #1 source of broken flows)

Every variable has TWO coordinated parts:

1. A **`modifiers` entry**, grouped by the lambda field name, keyed by a **freshly generated UUID v4**, holding the source path in `variable` and a `functions` array (`[]` when no function):

```json
"modifiers": {
  "temperature": {
    "13ad74e3-3354-463c-bf30-ea6e0c157ad8": {
      "variable": "$.6f978a68-f326-4889-89b8-ddd52eca15c0.weather.main.temp",
      "functions": []
    }
  }
}
```

2. A **`lambda` placeholder** referencing that UUID: `"temperature": "{{{13ad74e3-3354-463c-bf30-ea6e0c157ad8}}}"`.

The `variable` path is `$.COMPONENT_UUID.PORT_NAME.field.subfield`:
- `COMPONENT_UUID` — UUID of the upstream component (also present in `source`)
- `PORT_NAME` — that component's output port name (`out`, `weather`, `greater`, `item`, `request`, `response`, `error`, …)
- `field.subfield` — dot path into the output object

Critical rules:
- The raw `$.…` path goes ONLY in the modifier's `variable` field — **never** inside `{{{…}}}` and never as the modifier key. `{{{$.…}}}` corrupts the flow.
- Placeholders are triple-brace `{{{uuid}}}` — never `{{ }}` or `${}`.
- Generate a **new random UUID** for every variable; every `{{{uuid}}}` in `lambda` must have a matching `modifiers.<field>.<uuid>` entry, and vice versa (a modifier not bound in `lambda` is silently ignored).
- Placeholders can be embedded in a larger string, and one field may use several: `"subject": "Weather in {{{uuid1}}}: {{{uuid2}}}°C"` — each with its own modifier entry under that field.
- **No numeric array indexing in variable paths**: neither `$.x.out.items.0.id` nor `$.x.out.items[0].id` resolves. Reference the array path itself and use a modifier function (`g_jsonPath` with `"$[0].id"`, or `g_first` / `g_last`).
- An **array** path cannot be dotted into directly; an **object** path only as-is when the field expects an object — otherwise reference the specific leaf.
- Use only output variable paths confirmed by the discovery tools; never guess field names.
- **The path root often includes a wrapper object — check it.** The single most common
  mistake. Confirmed wrappers:
  - `appmixer.utils.appevents.OnAppEvent` nests the event payload under `data`, so with
    `eventDataExample` `{"msg": "hi"}` the path is `$.<trigger-uuid>.out.data.msg` —
    NOT `$.<trigger-uuid>.out.msg`.
  - `appmixer.utils.controls.Each` wraps each element of the list, so a list of
    `{"sku": "X1"}` yields `$.<each-uuid>.item.value.sku`, not `$.<each-uuid>.item.sku`.
  - HTTP actions expose the payload under `response`: `$.<uuid>.response.body.<field>`.

  Treat every dynamic port this way: create the flow first and call `get_flow_variables`,
  which returns the exact valid paths with all leaf fields, then fill in the transforms.

### 3d. Modifier functions

For computed values, add functions to the modifier's `functions` array (applied in order). Each is `{ "name": "g_…", "params": [...], "hashParams": {...} }` — omit whichever is empty. `params` = ordered positional args, each `{ "value": <v> }`; `hashParams` = named args keyed by name, each `{ "value": <v> }`.

```json
"functions": [{ "name": "g_length" }]
"functions": [{ "name": "g_jsonPath", "params": [{ "value": "Name" }] }]
"functions": [{ "name": "g_addTimeSpan", "hashParams": { "days": { "value": 1 } } }]
```

Common functions: `g_jsonPath`, `g_first`, `g_last`, `g_length`, `g_join`, `g_map`, `g_stringify`, `g_parse`, `g_replace`, `g_split`, `g_trim`, `g_formatDate`, `g_addTimeSpan`, `g_condition`, `g_now`, `g_uuid4`, `g_webhookUrl`. This list is only the common ones — call `list_modifiers` for the catalogue this tenant actually has (with descriptions and categories) rather than assuming a function exists.

### 3e. Inspector field value formats

The value format depends on the field's inspector type (same rules in `config.properties` and in `lambda`):

| Inspector type | Value |
|---------------|-------|
| `text` / `textarea` | String |
| `number` | Number (`42`) |
| `toggle` | Boolean |
| `select` | The option's `value` (not display label) |
| `multiselect` | Array of `value` strings, e.g. `["read", "write"]` |
| `date-time` | ISO 8601 string |
| `key-value` | **Stringified JSON object**: `"headers": "{\"Content-Type\": \"application/json\"}"` |

**`expression` type** (structured collections) produces a nested object whose keys come from the field's `levels`. Single level `["ADD"]`:

```json
"variables": { "ADD": [ { "type": "text", "name": "Test Name", "text": "hello" } ] }
```

Two levels `["AND", "OR"]` (e.g. the Condition component): `{ "AND": [ { "OR": [ { "input": "{{{uuid}}}", "operator": "contains", "value": "urgent" } ] } ] }`. Sub-field names come from the expression's `fields` definition; `{{{uuid}}}` placeholders inside the nested structure have their modifiers keyed by the **top-level** lambda field name.

### 3f. `config.auth`

The flow schema allows an optional `config.auth` object on a component. Connected accounts themselves are bound by the user (e.g. connecting an OAuth account in the designer) — the engine resolves the component's required scopes by componentId, which is why component IDs must be globally unique UUIDs. The sources do not define an authoring-time structure for `config.auth`; do not fabricate one — leave account connection to the platform/user.

## 4. Error Handling

Optional `errorHandling` object — a **sibling** of `type`/`source`/`config`, NOT inside `config`:

```json
"errorHandling": { "autoRetry": true, "maxRetries": 5, "onError": "errorPort" }
```

| Field | Meaning |
|-------|---------|
| `autoRetry` (boolean) | Engine retries the failed message with backoff. Default `true` |
| `maxRetries` (integer ≥ 0) | Cap on retries (system max typically 5). Omit for system default |
| `onError` (enum) | After retries exhausted (or immediately when `autoRetry: false`): `"errorPort"` (route to the virtual `error` port), `"stopFlow"`, or `"storeUnprocessed"` (default) |

The Designer calls these the same thing in different words, so map the user's
wording onto the enum: **Error port** → `errorPort`, **Stop flow** → `stopFlow`,
**Stop execution** → `storeUnprocessed` (the default). "Stop execution" stops only
that message: the flow keeps running, the failed message is parked in Unprocessed
Messages, and everything else keeps flowing. Parked messages are reachable with
`list_unprocessed_messages` / `get_unprocessed_message`, and once the flow is fixed
`retry_unprocessed_message` replays them — so nothing is lost by the default.

All fields optional; `{ "onError": "stopFlow" }` alone is valid. Schema is `additionalProperties: false` — no other keys.

With `"onError": "errorPort"`, wire a handler to the failing component's `error` port. Data available there:
- `$.<failing-uuid>.error.error.message` (also `.error.code`, `.error.name`)
- `$.<failing-uuid>.error.input` — the input the failing component received
- Upstream outputs remain accessible normally, e.g. `$.<trigger-uuid>.out.<field>`

## 5. Layout (x / y)

`x`/`y` are canvas pixels. Convention for readable left-to-right flows: each target at least **208 px right** of its source (`target.x >= source.x + 208`), and connected components either share a row (Δy = 0) or step vertically by at least **128 px**. Simple pattern: trigger at `x: 100, y: 200`, each next step +200 x; branches offset y by ±128 or more.

## 6. Common Validation Failures to Avoid

1. **Component ID not a UUID** — readable/reused IDs break OAuth account connection (global componentId scope lookup). Use a fresh UUID v4 per component.
2. **`source`/`transform` keyed on wrong inPort name** — uploads fine, but flow START is rejected with an opaque `400 "Malformed transformation"`. Use the component's real inPort name (usually `in`, but check).
3. **Link or variable references a non-existent outPort** — the flow uploads and starts, but the listener silently never receives a message (e.g. listening on `out` when the component's only outPort is `file`). Variables to bad ports render as invalid chips and never resolve.
4. **Lambda sends an object/array where the inPort schema says `"type": "string"`** (classic trap: key-value fields like `headers`/`parameters`) — serialize it: `"headers": "[{\"key\": \"Prefer\", \"value\": \"return=representation\"}]"`.
5. **Numeric array index in a variable path** (`.0.` or `[0]`) — never resolves; use `g_jsonPath`/`g_first`/`g_last` on the array.
6. **Modifier defined but not bound in `lambda`** (empty/missing lambda value) — the modifier is silently ignored.
7. **Raw `$.…` path inside `{{{…}}}`** or as the modifier key — corrupts the flow.
8. **`config.transform` not mirroring `source`** — the same upstream UUID and port name must appear in both.
9. **Missing required inPort fields in `lambda`**; **trigger with a non-empty `source`**; **references to UUIDs not present in the flow**; **transform type other than `json2new`**.
10. **Extra keys on the component descriptor** — `additionalProperties: false` rejects anything beyond the keys in section 1.
11. **Wrong path root — "Input field … contains invalid variable"**: the referenced field
   is not at that position in the upstream output. Typically a missing wrapper object
   (OnAppEvent: `$.uuid.out.data.field`, not `$.uuid.out.field`; Each: `$.uuid.item.value.field`).
   Fix by calling `get_flow_variables` and copying the exact `path` it reports.
12. **Fan-in into an inPort with `maxConnections: 1`** — the second connection is rejected.
   Merge the branches through `appmixer.utils.controls.Join` first (see section 2).

## 7. Complete Minimal Example

Scheduler (daily 9am) → SendEmail, mixing a static value and a variable reference:

```json
{
  "0e8ff425-1a1e-4c07-9f5e-2a9b4d6c8e01": {
    "type": "appmixer.utils.timers.Scheduler",
    "label": "Every day at 9am",
    "source": {},
    "config": {
      "properties": {
        "minute": "0", "hour": "9", "dayMonth": "*", "month": "*", "dayWeek": "*",
        "timezone": "UTC"
      }
    },
    "x": 100, "y": 200
  },
  "9c2d7b4a-5f3e-4a81-b06d-1c8e2f4a6b02": {
    "type": "appmixer.utils.email.SendEmail",
    "label": "Send Daily Report",
    "source": {
      "in": { "0e8ff425-1a1e-4c07-9f5e-2a9b4d6c8e01": ["out"] }
    },
    "config": {
      "transform": {
        "in": {
          "0e8ff425-1a1e-4c07-9f5e-2a9b4d6c8e01": {
            "out": {
              "type": "json2new",
              "modifiers": {
                "subject": {
                  "5f0a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b": {
                    "variable": "$.0e8ff425-1a1e-4c07-9f5e-2a9b4d6c8e01.out.now",
                    "functions": []
                  }
                }
              },
              "lambda": {
                "to": "admin@example.com",
                "subject": "Daily Report - {{{5f0a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b}}}",
                "text": "Your daily report is ready."
              }
            }
          }
        }
      }
    },
    "x": 300, "y": 200
  }
}
```

Note: the transform mirrors the source (`in` → trigger UUID → `out`), the variable path uses the trigger's UUID and `out` port, and the placeholder is the modifier UUID — never the raw path.

## 8. Useful Utility Components

Triggers: `appmixer.utils.controls.OnStart` (fires once on flow start, port `out`), `appmixer.utils.timers.Timer` (`interval` minutes, port `out`), `appmixer.utils.timers.Scheduler` (cron fields, port `out`), `appmixer.utils.http.WebhookTrigger` (port `request`: method, data, query, headers), `appmixer.utils.appevents.OnAppEvent` (port `out`; the event payload is nested under `data` — paths are `$.<uuid>.out.data.<field>` per the `eventDataExample` properties).

Data stores: `appmixer.utils.storage.*` components read and write named stores. They need the
store's ID, which `list_stores` reports — never guess it; `get_store_records` shows what is in
a store and `set_store_record` can seed data a flow will read.

Actions/control: `appmixer.utils.http.Get/Post/Put/Patch/Delete` (port `response`), `appmixer.utils.http.Response` (respond to a webhook), `appmixer.utils.controls.Condition`, `appmixer.utils.controls.Each` (ports `item`, `done`), `appmixer.utils.controls.SetVariable`, `appmixer.utils.storage.Set/Get`, filters like `appmixer.utils.filters.GreaterThan` (ports `greater`/`notGreater`) and `appmixer.utils.filters.Equal` (ports `equal`/`notEqual`), `appmixer.utils.email.SendEmail`.

Filters only pass/block messages — downstream variable references should point back to the original data source component, not to the filter.

Fan-in junction: `appmixer.utils.controls.Join` (inPort `in`, outPort `out`) merges branches
before a component whose inPort is limited to one connection.

### App events and chaining flows

App events are **inbound only**: `appmixer.utils.appevents.OnAppEvent` receives them, and no
component emits them — they are published from outside Appmixer (an application or the REST
API). Do not build a flow that "sends an app event".

To make one flow start another, give the second flow an `appmixer.utils.http.WebhookTrigger`
and have the first flow call that trigger's webhook URL with `appmixer.utils.http.Post`. The
trigger's webhook endpoint is public, so no credentials are needed for the call. Get the URL
with `get_trigger_url` once the second flow exists.

### Dynamic options

Some inspector fields and output ports do not list their values in the manifest — they carry a
`source` URL and resolve at runtime (a Slack channel picker, a Google Sheet list, output
variables generated from input data). Never guess such values (channel IDs, sheet IDs, dynamic
field names). Resolve them with `get_component_options`.

Read the field's `source` in the manifest: its `url` gives the component type and `outPort` to
call — often an **auxiliary component**, not the one you are configuring. For example
`appmixer.slack.list.SendChannelMessage`'s `channelId` field declares
`"url": "/component/appmixer/slack/list/ListChannels?outPort=channels"`, so you call type
`appmixer.slack.list.ListChannels` with `out_port: "channels"`, while `component_id` stays the
SendChannelMessage component in your flow. `source.data` is a template: literal values are sent
as they are, pointer strings such as `"event": "properties/event"` mean "send that property's
value", and `messages` entries carry inPort data (`{"in": {"types": "public_channel"}}`).

Two things to expect from the result:

- Components of connected services run the lookup **with the owning component's account**, so
  assign the account first (`assign_account`) or the call fails on authentication.
- The output is the auxiliary component's raw data. When the manifest's `source` declares a
  `transform`, that conversion happens in the designer, not here — so pick the identifier the
  target field expects yourself (for Slack channels, `id`; `name` is only the label).

### Components that need a connected account

A component whose manifest declares `auth` (every connected service: Slack, Google, HubSpot…)
must have one of the user's accounts bound to it. The binding lives outside the descriptor —
`config.auth` in the flow JSON does not create it, and the validator looks the account up by
component ID in a separate store. Binding also cannot be done up front: the component has to
exist in a saved flow first, otherwise the call fails with "Component not found in any of your
flows".

So the first validation of such a flow **always** reports
`{"keyword": "missingAccount", "message": "Not authenticated"}`. That is expected, not a
descriptor mistake — do not rewrite the flow to chase it. The order that works:

1. `list_accounts` — pick the account for the service (if the user has none, they must connect
   it in Appmixer first; it cannot be done through these tools).
2. `create_flow` — the "Not authenticated" error on this first pass is normal.
3. `assign_account` — bind the account to each component that needs one.
4. `get_component_options` — only now do account-backed lookups (channel lists, sheet lists) work.
5. `update_flow` with the resolved values, then `validate_flow` — now it comes back clean.

## 9. Editing an Existing Flow

Editing is not authoring a new flow that happens to look similar. `update_flow` **replaces** the
stored descriptor with what you send, so start from the current one — `get_flow` with
`include_descriptor: true` — and change only what was asked.

Rules that matter:

- **Keep the existing component IDs.** They are the identity of a component: account bindings
  (`assign_account`), every `$.<uuid>.…` variable reference and every `source` entry hang off
  them. Minting new IDs for components that already exist silently drops their connected
  accounts and breaks references. Generate fresh UUIDs only for components you are adding.
- **Keep the layout of untouched components.** Leave their `x`/`y` as they are and place new
  components relative to their neighbours (≥208 px to the right of the upstream one, rows
  ≥128 px apart), so an edit does not rearrange the user's diagram.
- **Keep configuration you were not asked to touch**, including `errorHandling` and properties
  of unrelated components. Anything you omit from the descriptor is deleted.
- **Rewire deliberately.** Inserting a step between A and B means changing B's `source` (and its
  `config.transform`, which mirrors `source`) to point at the new component, not just appending
  a component with no links.
- **Re-point variables when data moves.** If a value now comes from the inserted component,
  update the modifier's `variable` path; `get_flow_variables` reports the valid paths after the
  change is saved.
- **A running flow is rejected** with `Can't update a running flow` unless `update_flow` is
  called with `force: true`. Prefer `stop_flow` → `update_flow` → `start_flow`; use `force` when
  the user explicitly wants the running flow changed in place.
- **Validate after every edit** and re-check with `get_flow` that the components you meant to
  keep are still there.
- **Snapshot before a risky edit.** `create_flow_version` stores the current state and
  `restore_flow_version` brings it back; there is no undo otherwise. For a flow that is in
  use, `clone_flow` and editing the copy is safer still.

For a repair task ("this flow is failing"), read `get_flow_logs` first: it names the failing
component and the message, which usually points straight at the property or variable to fix.
Check `list_unprocessed_messages` as well — under the default error handling the failures are
parked there with the exact input that broke the component, and after the fix they can be
replayed instead of being lost.

## 10. Authoring Workflow (MCP)

1. **Discover** — list available apps (`list_apps`) and inspect candidate components (`get_components`) to get exact component types, inPort/outPort names, config properties, input fields (and which are required), and output variables. Never guess any of these.
2. **Build** — assemble the descriptor: one trigger with `"source": {}`, actions wired via `source`, transforms mirroring `source`, fresh UUIDs everywhere.
3. **Create** the flow via the create-flow tool (`POST /flows`).
4. **Verify variable paths** — call `get_flow_variables` and check that every modifier
   `variable` path exactly matches a reported path (watch for wrapper objects like
   OnAppEvent's `data`). This catches the most common validation failure before it happens.
   For fields backed by a `source` URL, resolve real values with `get_component_options`.
5. **Validate** — call `validate_flow`; fix every reported error (wrong port names, missing required fields, bad variable paths) and re-validate until clean. For components of connected services, expect one "Not authenticated" round: bind accounts with `assign_account` as described in section 8 instead of editing the descriptor.
6. **Dry-run** (optional but recommended) — `test_flow` with sample input on the first action verifies the transforms end to end without starting the flow.
7. **Start** — call `start_flow`. If start fails with a transformation error, re-check inPort key names and transform structure against section 6.
