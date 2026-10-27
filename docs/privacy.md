# Data Handling

The application is a local research prototype without authentication or tenant
isolation. Do not expose the application ports or example database configuration
as a public service.

API keys belong in the local `.env` and are not committed. The permanent key
remains server-side. Browser Voice sessions use short-lived credentials. Spoken
audio is processed by the external provider, and model evaluation sends transcript
content and profile instructions to that provider.

The normal application does not archive audio recordings. Optional synthetic
test tools may create local audio under the ignored data directory. No such audio,
database dump or participant database is included in this source tree.

Confirmed transcript turns remain the research source. Partial transcriptions
are not final evidence. An evaluation of an unfinished interview uses a snapshot
of confirmed turns and does not invent missing responses. Quoted evidence is
validated against participant turns.

All distributed example interviews are synthetic. A real study still requires
its own consent, access, retention and ethics arrangements. Technical transcript
checks do not provide legal approval or psychometric validation.
