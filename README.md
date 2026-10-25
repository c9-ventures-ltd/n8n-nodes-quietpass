# QuietPass for n8n

Phone intelligence for contact workflows: free formatting and validation, carrier and portability data, live network status, SMS support, and WhatsApp/Telegram registration.

This dedicated node calls the current [QuietPass API](https://quietpass.com/docs/). A QuietPass account with activated credit and a server API key is required. The node is free to install; live checks use existing QuietPass credit at your workspace prices.

## Availability

The package is available on npm for self-hosted n8n. It has been submitted for n8n verification; until n8n approves it, the node is not discoverable in n8n Cloud. npm publication and n8n verification are separate checkpoints. The existing [HTTP workflow and developer starter kit](https://quietpass.com/docs/#integration-kit) remain available.

## Installation

Self-hosted instance owners can install `n8n-nodes-quietpass` from **Settings → Community nodes → Install**. Follow [n8n's installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

For local development, use Node.js 22 or 24 and the pinned package manager:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm build
corepack pnpm test
corepack pnpm dev
```

`n8n-node dev` runs n8n with the node loaded. Use a separate development user folder; never attach development to a production n8n database. There are no runtime dependencies beyond n8n's supplied workflow SDK.

## Credentials

1. Finish account setup and credit activation in the [QuietPass console](https://quietpass.com/console).
2. Under **API keys & usage**, create a server API key and save it in your password manager.
3. Add a **QuietPass API** credential in n8n. Paste it into **Server API Key**.
4. Test the credential. This reads the free wallet endpoint; it does not check a phone number or buy credit.

n8n stores the credential separately from workflow data. Never put a key into a Set/Edit Fields node, expression, exported workflow, or contact record. HTTPS destinations are fixed and redirects are refused.

## Check a phone number

Select **Check Phone Number** and configure:

| Field | Value |
| --- | --- |
| Phone Number | Map text. International `+` or `00` inputs need no country. |
| Country for National Numbers | Map a two-letter country code, such as `GB` or `US`, for national input. No country is guessed. |
| Checks | Select phone and messaging checks. |
| Workspace Currency | Match the workspace's fixed GBP, USD, or EUR currency. |
| Maximum Price per Number | For example `0.05`. The server quote must fit this ceiling. |
| Stable Source Event ID | Include source/workflow, contact ID, and change ID: `crm:enrichment:123:change-456`. |
| Allow Live Lookup | Off by default. Turn on deliberately. Manual executions also use live credit. |
| Maximum Total Price per Run | Worst-case batch total; defaults to `1.00`. |

The node validates the batch, obtains a free quote, checks currency, price, and expiry, then submits that quote once. No wait or other node is needed between quote and execution. Each input produces one paired output item.

**Options → Maximum Input Items** defaults to 25. The batch-price limit is checked against the sum of per-number ceilings before any request. Increase limits deliberately for backfills. Items run sequentially.

## Results and mappings

Results keep the QuietPass API structure:

```text
number.e164                       normalized number
number.valid                      numbering-plan validity
number.type                       resolved line type
number.carrier                    resolved carrier
number.ported                     portability observation
contact.sms.supported             supported / unsupported / unavailable
contact.sms.assumed                true when inferred from mobile type
contact.sms.basis                  basis of the SMS result
contact.whatsapp.registered        account registration
contact.telegram.registered        account registration
network.reachable                 observed network reachability
billing.currency                  workspace currency
billing.chargedMicros              millionths; 50000 = 0.05
requestId                         support reference
operation                         original quote, cap, request key, and currency
```

`false` is a definite negative; `null` is unavailable and must not overwrite a known value as false. Check reason fields. App registration and reachability do not guarantee delivery, consent, or ownership. SMS inferred from line type remains marked `assumed`; direct SMS-enablement answers take precedence where available.

Enable **Options → Include Details** for retained evidence and timestamps, without another query.

## Other operations

- **Format Phone Number:** free numbering-plan validation and formatting with basic type. Does not confirm assignment, ownership, or reachability.
- **Quote Lookup:** free price review. Returns `operation` references but no contact result. Quotes expire after five minutes.
- **Get Lookup Result:** read the original result using its Quote ID without a new charge. Pending, not-started, expired, and unknown states stop downstream updates.
- **Submit Original Quote:** submit or retry a saved quote with its exact ID, maximum, request key, and currency. Never requotes. Requires Allow Live Lookup. Server idempotency protects replay of the same original operation.

## Interrupted requests and retries

Keep **Retry On Fail off for Check Phone Number**. That setting is rejected before any request: repeating a combined quote/execute node cannot safely recover a lost quote reference. A fresh execution is not recovery.

Map a stable source event ID for each intentional lookup. The node hashes it into a request key; it never contains the raw event ID or phone. Reusing an event ID with a replacement quote is rejected by the server instead of buying another lookup. Do not change the ID to bypass this protection.

On interrupted execution, error details contain a sanitized original `operation`. With Continue On Fail, the item contains `error` and `operation`, without fake contact answers. Route errors to recovery/support, not CRM updates.

1. Save the original references from the error or quote output.
2. Use **Get Lookup Result** with the original Quote ID.
3. If not started, use **Submit Original Quote** with unchanged references while valid. Retries retain these exact references; they never create another quote.
4. If pending, wait and read again. If expired, inspect the original charge before deliberately creating a new event.

Results expire after 24 hours; financial history remains. A process crash before references are saved may require operator investigation. Production workflows should keep a durable per-event operation record. The node does not claim transactional storage inside n8n.

## Workflow examples

`examples/` contains inactive exports with the phone library’s US example number (+1 201 555 0123) and no credentials. Connect your QuietPass credential after import. Paid execution is off until deliberately enabled; quote output is not a lookup result.

- **Free contact formatting:** normalize example rows and preserve their source references.
- **Contact enrichment:** review a quote, submit its exact references, then prepare CRM fields. Live execution is off by default. Route errors separately and omit unavailable fields from writes.

The examples do not create CRM accounts/properties, send messages, or modify a CRM. Connect the prepared contact output to your destination and trigger only for new or changed numbers to avoid loops.

## Privacy

During live runs, n8n stores/processes mapped numbers and results, and QuietPass uses its existing providers. Restrict workflow access and execution-data retention. This node adds no telemetry, credential logging, environment access, filesystem access, or third-party network destinations. No real numbers or credentials are included.

## Maintenance and release

Programmatic style is needed for dependent quote/execute calls, whole-batch spending validation, and recovery branching. The node was scaffolded and checked with the official `n8n-node` tool.

The public source contains only this connector. Releases must pass lint, build, and tests, then publish through `.github/workflows/publish.yml` with npm provenance. Publication does not imply verification. See [RELEASING.md](RELEASING.md).

Support: [hello@quietpass.com](mailto:hello@quietpass.com). Include the request ID and original Quote ID, never an API key or a customer list.
