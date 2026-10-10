# Generates the v2 task set: python3 bench/gen_tasks_v2.py bench/tasks/tasks-v2.jsonl
# Labels were checked by a blind second annotator; 11 debatable tasks were rewritten.
import json, sys
T = []
def ch(id, ctx, instr, opts, label):
    assert label in [o[0] for o in opts], id
    T.append(dict(id=id, context=ctx, question=dict(id="q", type="choice", instructions=instr,
        options=[dict(value=v, description=d) for v, d in opts]), label=label))
def bi(id, ctx, instr, label, crit=None):
    q = dict(id="q", type="binary", instructions=instr)
    if crit: q["criteria"] = crit
    T.append(dict(id=id, context=ctx, question=q, label=label))
def sc(id, ctx, instr, levels, label):
    assert label in [l[0] for l in levels], id
    T.append(dict(id=id, context=ctx, question=dict(id="q", type="score", instructions=instr,
        levels=[dict(label=a, description=b) for a, b in levels]), label=label))
def rk(id, ctx, instr, cands, label):
    assert label in [c[0] for c in cands], id
    T.append(dict(id=id, context=ctx, question=dict(id="q", type="rank", instructions=instr,
        candidates=[dict(id=a, text=b) for a, b in cands]), label=label))

# ---------- CHOICE A: work-item kind (6 options) ----------
K = "What kind of work item is this?"
KO = [("bug", "existing behavior is incorrect or broken"), ("feature", "new user-facing capability"),
      ("refactor", "internal restructuring with no behavior change"), ("docs", "documentation only"),
      ("performance", "works correctly but too slow or resource-hungry"), ("security", "vulnerability or exposure of data/credentials")]
ch("k01", "Issue: The /search endpoint returns correct results but p95 latency went from 120ms to 2.4s after we added the tags join. CPU on the DB is pegged.", K, KO, "performance")
ch("k02", "Issue: Password reset tokens never expire. Anyone with an old reset email link can still take over the account months later.", K, KO, "security")
ch("k03", "Issue: Add an 'Export to PDF' button on the invoice page so customers can download invoices.", K, KO, "feature")
ch("k04", "Issue: OrderService is 2,400 lines. Split it into OrderPricing, OrderFulfilment and OrderNotifications. No behavior changes; existing tests must pass unchanged.", K, KO, "refactor")
ch("k05", "Issue: The CONTRIBUTING guide tells people to run `make test`, but the Makefile was removed in v4; it should say `pnpm test`.", K, KO, "docs")
ch("k06", "Issue: Dates on the dashboard show one day earlier than the actual date for users in UTC-5 and further west.", K, KO, "bug")
ch("k07", "Issue: Our API error responses include the full SQL query and stack trace, including the database host and username, when DEBUG is off in production.", K, KO, "security")
ch("k08", "Issue: Since v5 the worker uses a steady 6GB of RAM instead of 1GB. It never crashes and its results are correct; we just need bigger machines.", K, KO, "performance")
ch("k09", "Issue: Clicking 'Save' on the profile form does nothing on Firefox; works on Chrome. No console errors.", K, KO, "bug")
ch("k10", "Issue: Support signing in with GitHub in addition to email and Google.", K, KO, "feature")
ch("k11", "Issue: Replace our hand-rolled retry loops in six HTTP clients with the shared `withRetry` helper. Behavior and timeouts stay identical.", K, KO, "refactor")
ch("k12", "Issue: The API reference page for /v2/orders lists a `limit` default of 50; the code's default is 20 and has been since v2.0. Fix the page.", K, KO, "docs")
ch("k13", "Issue: Uploading a file with a name like '../../etc/cron.d/job' writes it outside the uploads directory.", K, KO, "security")
ch("k14", "Issue: The nightly report job takes 7 hours because it issues one query per customer (N+1). Output is correct.", K, KO, "performance")
# ---------- CHOICE B: owning area (5 options) ----------
A = "Which team area should own this issue?"
AO = [("frontend", "browser UI, CSS, client-side state"), ("backend", "API servers and business logic"),
      ("database", "schema, queries, indexes, migrations"), ("infra", "deploys, networking, cloud resources, DNS, TLS"),
      ("ci", "build, test pipeline, GitHub Actions")]
ch("a01", "The checkout button overlaps the price on iPhone SE widths; looks fine on desktop.", A, AO, "frontend")
ch("a02", "Our TLS certificate for api.example.com expired last night and clients get certificate errors.", A, AO, "infra")
ch("a03", "Pull requests from forks never run the test workflow; the GitHub Actions job is skipped with 'secrets not available'.", A, AO, "ci")
ch("a04", "The orders table has no index on customer_id; EXPLAIN shows a sequential scan on 40M rows for every lookup.", A, AO, "database")
ch("a05", "The /refunds endpoint refunds the full amount even when the request asks for a partial refund; the bug is in the refund calculation function.", A, AO, "backend")
ch("a06", "The dark-mode toggle resets to light mode on every page load because the preference isn't persisted in localStorage.", A, AO, "frontend")
ch("a07", "Builds on main fail since yesterday: the Docker build step in the release workflow can't pull the base image (rate-limited by Docker Hub).", A, AO, "ci")
ch("a08", "The load balancer health check points at /health on port 8080, but the service moved to port 9000, so all instances are marked unhealthy.", A, AO, "infra")
ch("a09", "The API returns 200 with an empty list when the user lacks permission, instead of 403; the authorization check in the controller is missing.", A, AO, "backend")
ch("a10", "We need to rename column `usr_name` to `username` across the users table without downtime.", A, AO, "database")
ch("a11", "The test suite on CI takes 45 minutes because tests run serially; split them across parallel jobs in the workflow.", A, AO, "ci")

# ---------- BINARY A: breaking change to public API ----------
B = "Is this change a breaking change for existing users of the public API?"
bi("b01", "Public Python package. Diff: `def connect(host, port=5432)` -> `def connect(host, port=5432, ssl=False)`.", B, False)
bi("b02", "Public REST API. Response field `created` changed from a Unix timestamp integer to an ISO-8601 string.", B, True)
bi("b03", "Public TypeScript SDK. The exported function `parseConfig` was renamed to `loadConfig`; `parseConfig` is removed.", B, True)
bi("b04", "Public REST API. A new optional query parameter `include_archived` (default false) was added to GET /projects.", B, False)
bi("b05", "Public Go module. A new method `Close()` was added to the exported `Client` struct.", B, False)
bi("b06", "Public Go module. A new method `Flush() error` was added to the exported `Store` interface that users implement themselves.", B, True)
bi("b07", "Public CLI. The `--verbose` flag's short form changed from `-v` to `-V`; `-v` now prints the version.", B, True)
bi("b08", "Internal refactor: private helper `_normalize_path` moved from utils.py to paths.py. Nothing public imports it.", B, False)
bi("b09", "Public REST API. The maximum page size for GET /events was lowered from 500 to 100; requests with limit=500 now return 400.", B, True)
bi("b10", "Public Java library. A method's return type changed from `List<User>` to `Collection<User>`.", B, True)
bi("b11", "Public REST API. Error responses gained an extra field `request_id`; existing fields are unchanged.", B, False)
bi("b12", "Public Python package. `Client.__init__(self, api_key)` became `Client.__init__(self, api_key, region)`; `region` is required with no default.", B, True)
bi("b13", "Public npm package. Fixed a typo in a code comment and in the README.", B, False)
# ---------- BINARY B: needs a database schema migration ----------
M = "Does implementing this change require a database schema migration?"
bi("m01", "Add a 'phone_number' field that users can save on their profile; profiles are stored in the users table.", M, True)
bi("m02", "Change the color of the 'Delete' button from red to dark red.", M, False)
bi("m03", "Fix a bug where the API returned amounts in cents instead of dollars; the database stores cents correctly.", M, False)
bi("m04", "Allow an order to have multiple shipping addresses; today orders.shipping_address_id is a single foreign key.", M, True)
bi("m05", "Cache the result of the /stats endpoint in Redis for 60 seconds.", M, False)
bi("m06", "Make the email column unique so two accounts can't share an email; currently duplicates are allowed at the DB level.", M, True)
bi("m07", "Rename the 'Teams' page title to 'Workspaces' in the UI only.", M, False)
bi("m08", "Store an audit trail of every permission change, with who changed it and when; no such table exists.", M, True)
bi("m09", "Retry failed webhook deliveries up to 5 times using the existing job queue.", M, False)
bi("m10", "Speed up lookups of invoices by customer by adding an index on invoices.customer_id.", M, True)
bi("m11", "Validate that usernames are at least 3 characters in the signup form and API handler.", M, False)
bi("m12", "Support soft-deleting projects so they can be restored within 30 days; projects are currently hard-deleted.", M, True)

# ---------- SCORE A: review comment severity ----------
S = "How severe is the issue raised in this code review comment?"
SL = [("nit", "style, naming, or formatting only"), ("minor", "small clarity or correctness issue with little impact"),
      ("major", "likely bug, missing error handling, or broken edge case"), ("blocker", "security hole, data loss, or crash in a common path")]
sc("s01", "Review comment: 'Prefer `const` over `let` here, the variable is never reassigned.'", S, SL, "nit")
sc("s02", "Review comment: 'This endpoint deletes the account without checking the caller owns it; any logged-in user can delete anyone.'", S, SL, "blocker")
sc("s03", "Review comment: 'An empty-string discount code is treated as an invalid code, so the order is rejected; this hits every customer who types a code and then clears the field.'", S, SL, "major")
sc("s04", "Review comment: 'Retry backoff here is a fixed 1 second instead of exponential; with only 2 retries the impact is small, but it should match the other clients.'", S, SL, "minor")
sc("s05", "Review comment: 'Trailing whitespace on lines 12 and 40.'", S, SL, "nit")
sc("s06", "Review comment: 'The migration drops the `notes` column but nothing copies its data first; we lose every customer note on deploy.'", S, SL, "blocker")
sc("s07", "Review comment: 'Dividing by `items.length` crashes with an empty cart, which happens on every new session.'", S, SL, "blocker")
sc("s08", "Review comment: 'This comparison uses `==` on floats; totals like 0.1 + 0.2 won't match the expected value, so the discount check fails for some carts.'", S, SL, "major")
sc("s09", "Review comment: 'Typo in a local variable name: `recieved` should be `received`.'", S, SL, "nit")
sc("s10", "Review comment: 'Variable `d` should have a descriptive name like `durationMs`.'", S, SL, "nit")
sc("s11", "Review comment: 'The API key is hard-coded in this file and the repo is public.'", S, SL, "blocker")
sc("s12", "Review comment: 'Pagination skips the last item when the total is an exact multiple of the page size.'", S, SL, "major")
sc("s13", "Review comment: 'The error tells users to check their password when the real cause is an expired account; they get confused but support can sort it out.'", S, SL, "minor")
# ---------- SCORE B: incident severity ----------
I = "What severity level fits this production incident?"
IL = [("SEV4", "cosmetic or internal-only, no customer impact"), ("SEV3", "minor customer impact with a workaround"),
      ("SEV2", "major feature degraded for many customers, no workaround"), ("SEV1", "full outage, data loss, or security breach")]
sc("i01", "Incident: The entire site returns 503 for all users; nobody can log in or use the product.", I, IL, "SEV1")
sc("i02", "Incident: A typo in the footer of the marketing site reads 'Copyrihgt'.", I, IL, "SEV4")
sc("i03", "Incident: CSV export is failing for all customers; the in-app table and the API still work, and support can send exports manually.", I, IL, "SEV3")
sc("i04", "Incident: The order history page returns 500 for all customers; checkout, login and everything else work, and there is no other way to see past orders.", I, IL, "SEV2")
sc("i05", "Incident: An S3 bucket containing customer passport scans was found publicly readable.", I, IL, "SEV1")
sc("i06", "Incident: The internal admin dashboard's charts load slowly; customers are unaffected.", I, IL, "SEV4")
sc("i07", "Incident: Push notifications are delayed by up to 20 minutes for all mobile users; in-app messages are still delivered in real time.", I, IL, "SEV3")
sc("i08", "Incident: In-app search returns no results for any customer, and the app has no other way to find documents; everything else works.", I, IL, "SEV2")
sc("i09", "Incident: A bad migration deleted the last 6 hours of orders and there is no backup covering that window.", I, IL, "SEV1")
sc("i10", "Incident: Profile pictures fail to upload for ~2% of users on Android; they can retry from the web app.", I, IL, "SEV3")
sc("i11", "Incident: A staging environment certificate expired; production is unaffected.", I, IL, "SEV4")
sc("i12", "Incident: 'Sign in with Google' fails for everyone who uses it; email and password login works for all of those accounts and the login page says so.", I, IL, "SEV3")

# ---------- RANK: most relevant file for a bug (with plausible distractors) ----------
R = "How relevant is this file to fixing the bug?"
rk("r01", "Bug: Users in Germany see prices with a dot as the decimal separator (12.50 €) instead of a comma (12,50 €).", R,
   [("a", "ui/PriceTag.tsx: renders a price; calls formatMoney(amount, locale)"), ("b", "lib/formatMoney.ts: formats numbers with a hard-coded en-US Intl.NumberFormat"),
    ("c", "api/prices.py: returns prices as integers in cents"), ("d", "i18n/de.json: German UI strings")], "b")
rk("r02", "Bug: Password reset emails are sent but the link in them 404s; the route was renamed from /reset to /password/reset last week.", R,
   [("a", "emails/templates/reset.html: email body containing the reset link built from RESET_URL"), ("b", "config/urls.py: defines RESET_URL = '/reset/{token}'"),
    ("c", "auth/tokens.py: generates and validates reset tokens"), ("d", "web/routes.ts: frontend router with /password/reset route")], "b")
rk("r03", "Bug: Uploads larger than 10MB fail with 413 Request Entity Too Large, but the app's own limit is 100MB.", R,
   [("a", "app/upload_handler.py: enforces MAX_UPLOAD=100MB"), ("b", "deploy/nginx.conf: reverse proxy config with client_max_body_size 10m"),
    ("c", "ui/Uploader.tsx: file picker with a 100MB check"), ("d", "docs/limits.md: documents upload limits")], "b")
rk("r04", "Bug: Scheduled reports run at 09:00 UTC instead of 09:00 in the customer's timezone.", R,
   [("a", "scheduler/cron.py: builds cron triggers from report.time, ignoring report.timezone"), ("b", "models/report.py: Report model with time and timezone fields"),
    ("c", "ui/ScheduleForm.tsx: form that lets users pick time and timezone"), ("d", "emails/report_email.py: sends the report email")], "a")
rk("r05", "Bug: Duplicate charges occur when users double-click 'Pay'; the payment provider receives two requests without an idempotency key.", R,
   [("a", "payments/client.py: calls the provider's charge API; no idempotency key header is set"), ("b", "ui/PayButton.tsx: button that submits payment"),
    ("c", "payments/webhooks.py: handles provider webhooks"), ("d", "models/order.py: Order model")], "a")
rk("r06", "Bug: The mobile app crashes on launch for users whose saved settings JSON lacks the new 'theme' key.", R,
   [("a", "app/settings/loadSettings.ts: parses saved settings and reads settings.theme.mode without a default"), ("b", "app/theme/colors.ts: color palette"),
    ("c", "app/settings/SettingsScreen.tsx: settings UI"), ("d", "server/api/settings.py: settings API")], "a")
rk("r07", "Bug: CSV exports open with garbled characters (Ã©) in Excel for names with accents.", R,
   [("a", "export/csv_writer.py: writes CSV with utf-8 encoding and no BOM"), ("b", "models/customer.py: Customer model with name field"),
    ("c", "ui/ExportButton.tsx: triggers the export"), ("d", "db/collation.sql: database collation settings")], "a")
rk("r08", "Bug: After deploy, users are logged out every few minutes; there are 3 app instances behind the load balancer and sessions are stored in memory.", R,
   [("a", "app/session.py: in-process memory session store"), ("b", "ui/Header.tsx: shows the logged-in user's name"),
    ("c", "ui/LoginForm.tsx: login form"), ("d", "auth/password.py: password hashing")], "a")
rk("r09", "Bug: The 'Remember me' checkbox has no effect; the session cookie always expires when the browser closes.", R,
   [("a", "auth/login_view.py: sets the session cookie without max_age even when remember_me is true"), ("b", "ui/LoginForm.tsx: renders the remember-me checkbox and sends remember_me"),
    ("c", "auth/password.py: password hashing"), ("d", "config/security.py: CSRF settings")], "a")
rk("r10", "Bug: Search results are missing products added in the last hour; the search index is rebuilt by a nightly job only.", R,
   [("a", "search/indexer.py: nightly full re-index job; no incremental updates on product create"), ("b", "search/query.py: builds the search query"),
    ("c", "products/create.py: saves new products to the database"), ("d", "ui/SearchBox.tsx: search input")], "a")
rk("r11", "Bug: API rate limiting blocks all users from the same office because limits are keyed by IP address.", R,
   [("a", "middleware/ratelimit.py: computes the limit key from request.remote_addr"), ("b", "config/limits.yaml: requests-per-minute numbers"),
    ("c", "auth/api_keys.py: API key validation"), ("d", "docs/rate-limits.md: rate limit documentation")], "a")
rk("r12", "Bug: Emails to customers show 'Hello {{first_name}}' literally instead of their name.", R,
   [("a", "emails/render.py: renders templates with str.format, which doesn't understand {{ }} syntax"), ("b", "emails/templates/welcome.txt: template using {{first_name}}"),
    ("c", "models/customer.py: Customer with first_name"), ("d", "emails/send.py: SMTP sending")], "a")
rk("r13", "Bug: The dashboard total shows 1,000 when there are 1,243 records; the count query uses the paginated list's length.", R,
   [("a", "dashboard/stats.py: total = len(list_records(limit=1000))"), ("b", "db/records.py: list_records with a limit parameter"),
    ("c", "ui/StatCard.tsx: displays the number"), ("d", "cache/redis.py: caching layer")], "a")


rk("r14", "Bug: Users get 'CSRF token missing' on every form submit after we moved the app under the /app subpath.", R,
   [("a", "config/security.py: CSRF_COOKIE_PATH = '/' replaced by '/app' in a recent change, while forms post to /submit at the root"), ("b", "ui/Form.tsx: generic form component"),
    ("c", "auth/password.py: password hashing"), ("d", "deploy/ingress.yaml: routes /app to the service")], "a")
rk("r15", "Bug: Daily active user counts doubled overnight; the analytics job now counts each user once per device instead of once per user.", R,
   [("a", "analytics/dau.sql: SELECT COUNT(DISTINCT device_id) ... changed from user_id yesterday"), ("b", "analytics/dashboard.tsx: chart for DAU"),
    ("c", "mobile/telemetry.ts: sends device_id and user_id with events"), ("d", "docs/metrics.md: metric definitions")], "a")
rk("r16", "Bug: Webhooks to customers are rejected with 'invalid signature' since we upgraded the JSON library, which now emits keys in a different order.", R,
   [("a", "webhooks/sign.py: signs json.dumps(payload) instead of the exact bytes that are sent"), ("b", "webhooks/send.py: posts the payload with a re-serialized body"),
    ("c", "models/webhook.py: endpoint URLs and secrets"), ("d", "ui/WebhookSettings.tsx: settings page")], "a")
rk("r17", "Bug: The 'Forgot password' page leaks whether an email is registered ('No account with that email').", R,
   [("a", "auth/forgot_password.py: returns a different message when the user doesn't exist"), ("b", "emails/templates/reset.html: reset email"),
    ("c", "auth/tokens.py: token generation"), ("d", "ui/ForgotPassword.tsx: shows the server's message")], "a")
rk("r18", "Bug: Background jobs stop processing after Redis restarts; the worker never reconnects.", R,
   [("a", "workers/queue.py: creates one Redis connection at startup with no reconnect or retry"), ("b", "deploy/redis.tf: Redis instance config"),
    ("c", "jobs/send_email.py: an example job"), ("d", "ui/JobsPage.tsx: admin jobs list")], "a")
rk("r19", "Bug: Generated invoice PDFs cut off the last line item when there are more than 20 items.", R,
   [("a", "invoices/pdf.py: renders line items into a fixed-height table with no page break"), ("b", "invoices/models.py: Invoice and LineItem models"),
    ("c", "invoices/email.py: emails the PDF"), ("d", "ui/InvoiceView.tsx: on-screen invoice (shows all items correctly)")], "a")
rk("r20", "Bug: Sorting the users table by 'Last active' sorts alphabetically ('10 days ago' before '2 days ago').", R,
   [("a", "ui/UsersTable.tsx: sorts by the formatted relative-time string instead of the timestamp"), ("b", "api/users.py: returns last_active as an ISO timestamp"),
    ("c", "lib/relativeTime.ts: formats timestamps as '2 days ago'"), ("d", "db/users.sql: users table schema")], "a")
rk("r21", "Bug: The app's Docker image is 2.1GB; it includes node_modules dev dependencies and the .git directory.", R,
   [("a", "Dockerfile: single-stage build with COPY . . and npm install (no --omit=dev)"), ("b", "scripts/lint.sh: runs eslint and prettier"),
    ("c", "package.json: dependencies list"), ("d", "ci/build.yml: builds and pushes the image")], "a")
rk("r22", "Bug: Feature flags flip randomly for the same user between page loads; the flag service hashes a random request id instead of the user id.", R,
   [("a", "flags/evaluate.ts: bucket = hash(requestId) % 100"), ("b", "flags/config.json: rollout percentages"),
    ("c", "ui/FeatureGate.tsx: shows/hides UI by flag"), ("d", "api/middleware/requestId.ts: assigns a random request id")], "a")
rk("r23", "Bug: Two users editing the same document at once silently overwrite each other's changes; the last save wins with no conflict warning.", R,
   [("a", "docs/save.py: UPDATE documents SET body=... WHERE id=... with no version check"), ("b", "ui/Editor.tsx: rich text editor"),
    ("c", "docs/models.py: Document model (has an unused `version` column)"), ("d", "realtime/presence.ts: shows who is viewing")], "a")
rk("r24", "Bug: The 'Download all' ZIP of user files times out for users with many files because it is built in memory inside the request.", R,
   [("a", "files/download_all.py: builds the full ZIP in memory synchronously before responding"), ("b", "storage/s3.py: S3 client wrapper"),
    ("c", "ui/FilesPage.tsx: download button"), ("d", "deploy/lb.tf: load balancer idle timeout of 60s")], "a")
rk("r25", "Bug: Accented characters in usernames break login: 'José' can register but can never log in.", R,
   [("a", "auth/login.py: normalizes the submitted username with NFKD before lookup, while signup stores NFC"), ("b", "auth/signup.py: stores the username as submitted (NFC from browsers)"),
    ("c", "ui/LoginForm.tsx: login form"), ("d", "db/users.sql: username column with utf8mb4")], "a")

# shuffle candidate positions deterministically so the right answer is not always 'a'
import random
rnd = random.Random(7)
for t in T:
    q = t["question"]
    if q["type"] == "rank":
        c = q["candidates"]; rnd.shuffle(c)
        mapping = {old["id"]: new for old, new in zip(c, "abcde")}
        t["label"] = mapping[t["label"]]
        for x in c: x["id"] = mapping[x["id"]]
        c.sort(key=lambda x: x["id"])
print(len(T), {k: sum(1 for t in T if t["question"]["type"] == k) for k in ["choice", "binary", "score", "rank"]}, file=sys.stderr)
open(sys.argv[1], "w").write("".join(json.dumps(t) + "\n" for t in T))
