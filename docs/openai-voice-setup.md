# Set Up OpenAI Voice

Voice mode uses a native OpenAI Realtime session:

- [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
  conducts the interview with audio input and output.
- [`gpt-live-transcribe`](https://developers.openai.com/api/docs/guides/realtime-transcription)
  provides partial and final participant transcripts within the session.
- `marin` is the default Realtime voice.

The browser connects directly to OpenAI following the
[official WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc).
The backend creates a short-lived client secret for this purpose; the permanent
API key is never sent to the browser. A ChatGPT Free, Plus, Pro, or Business
subscription does not enable API access: ChatGPT and the API platform are
[billed separately](https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api).

## 1. Enable the API Account and Billing

1. Sign in to the [OpenAI API Platform](https://platform.openai.com/) or create an
   account.
2. Open the [API billing overview](https://platform.openai.com/settings/organization/billing/overview)
   and set up a payment method or prepaid credits. The
   [official prepaid guide](https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing)
   also describes auto-recharge and its monthly limit.
3. Under [Projects](https://platform.openai.com/settings/organization/projects),
   create a dedicated project, for example `Live Interview Agent MVP`. Only
   Organization Owners can create new projects; the existing `Default project`
   also works for a local test.
4. In the project, open `Limits`, set a small `Monthly spend limit`, and enable
   `Enforce a hard limit`. Additional warnings below the limit are useful. A
   warning threshold alone does not stop requests; see the official
   [Spend Limits guide](https://developers.openai.com/api/docs/guides/spend-limits)
   for details.

## 2. Create an API Key

1. Select the project you just created and open the
   [API keys page](https://platform.openai.com/api-keys).
2. Select `Create new secret key`, give it a unique name such as
   `local-live-interview`, and assign the key to the project.
3. For the first local MVP test, you can use `All`. Later, restrict the key to
   the endpoints actually needed in the project settings. OpenAI documents the
   `All`, `Restricted`, and `Read Only` options under
   [Managing projects](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects).
4. Copy the displayed value into a password manager immediately. For security
   reasons, the full secret key is
   [shown only once](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key).

Never put the key in the browser, frontend code, chat, a Git commit, or a
screenshot. The application uses it only in the backend, following the official
[API key security recommendations](https://help.openai.com/en/articles/5112595-best-practices-for-api-key).

## 3. Local Configuration

Run this from the repository root:

```sh
cp .env.example .env
```

Then set exactly this line in `.env`:

```dotenv
OPENAI_API_KEY=sk-proj-YOUR_SECRET_KEY
```

The Realtime defaults are:

```dotenv
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_TRANSCRIPTION_MODEL=gpt-live-transcribe
OPENAI_REALTIME_VOICE=marin
```

`.env` is local and must not be committed.

## 4. Start and Verify Safely

```sh
docker compose up --build
```

In a second terminal, check whether the key is available in the backend without
printing it:

```sh
docker compose exec backend sh -lc \
  'if [ -n "$OPENAI_API_KEY" ]; then echo "OPENAI_API_KEY is set"; else echo "OPENAI_API_KEY is missing"; exit 1; fi'
```

Then open <http://localhost:5273>, select a Markdown interview guide, enable
`Voice`, start the interview, and allow microphone access in the browser.
Monitoring is available at <http://localhost:5274> at the same time.

## 5. Verify the English Voice Path

This manual check covers browser permission, real audio recording, and audio
playback; API and mock tests do not replace this hardware check:

1. Record the browser name and date, select `English` in the interview frontend,
   and upload `examples/organizational-resilience.en.md`.
2. Open Monitoring at the same time, select the same interview, and reload both
   interfaces once if needed.
3. Start `Voice`, wait for the English greeting and first question, and speak a
   deliberately partial answer that clearly identifies one missing aspect.
4. Check that exactly one specific English clarification question follows, that
   the answer appears as a final participant turn, and that no German system
   phrase occurs.
5. Continue the interview through the English closing. Status, transcript, and
   events must be complete in Monitoring.
6. Export Markdown, JSON, and text in the interview frontend. Then start the
   evaluation in Evaluation Studio and export JSON, CSV, Markdown, and HTML.
7. Restart the stack without deleting volumes and check that the language,
   transcript, and report are preserved.

For the acceptance record, note only the browser, date, `gpt-realtime-2.1`,
`gpt-live-transcribe`, result, and any errors. Do not commit the API key, audio
recording, or short-lived client secret.

### Current Provider Acceptance Status

On September 3, 2026, a real Chrome WebRTC run successfully reached the backend
endpoint, received a short-lived `gpt-realtime-2.1` session, and sent the SDP
offer to OpenAI. OpenAI then rejected the connection with
`429 credit_balance_exhausted`. The application displays the localized API limit
message, without provider details. This confirms the integration up to the
provider boundary, but not yet a completed audio interview.

No code deployment is required after adding API credits. Start Voice mode again
and then perform the seven steps in this section. The automated Chrome test
`npm run test:browser:i18n` also covers the bilingual two-tab text path.

## Common Errors

- Missing `OPENAI_API_KEY`: The application reports that OpenAI Voice is not
  configured. Check `.env` and rebuild the stack with `docker compose up --build`
  after a change.
- Invalid server-side Voice configuration: The application displays a neutral
  configuration message; internal configuration details are not exposed.
- `401`, `invalid_api_key`, or `Incorrect API key`: Enter the key without quotes
  or spaces; generate a new key if it is lost.
- `429` with `credit_balance_exhausted` or `insufficient_quota`: Check API billing
  or available credits.
- `429` with `project_spend_limit_exceeded` or
  `organization_spend_limit_exceeded`: The configured hard spend limit has been
  reached. Deliberately adjust the limit or wait until the next monthly cycle.
- Model access denied: Check the project limits to confirm that
  `gpt-realtime-2.1` and `gpt-live-transcribe` are allowed.
- Microphone does not start: Check browser permission and the selected input
  device. Browsers treat `localhost` as a secure context for media APIs.

## Rotate the Key

If you suspect exposure, immediately create a new key on the
[API keys page](https://platform.openai.com/api-keys), replace `OPENAI_API_KEY` in
`.env`, restart the containers, and only then delete the old key. OpenAI also
recommends checking the [Usage page](https://platform.openai.com/usage) for
unknown requests.
