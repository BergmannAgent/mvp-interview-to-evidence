# Automatisiertes synthetisches Realtime-Interview

Dieser Test verwendet den **gespeicherten deutschen Default-Leitfaden**, ohne
ihn zu veraendern. Der aktuelle Testteilnehmer passt zu
`guides/interviewleitfaden-organizational-resilience-9-items.md`: zwoelf Hauptfragen und
39 moegliche Unterfragen. Ein anderer Leitfaden wird vor der Interviewerstellung
abgelehnt, damit keine falschen Beispielantworten zugeordnet werden. Das
beschraenkt nur diese konkrete Testfixture, nicht die Anwendung oder ihre Profile.

## Was echt ist

- Interviewer: echte API-Session mit `gpt-realtime-2.1`, bestehende Instructions
  und das regulaere `plan_interview_turn`-Tool.
- Fragenauswahl: vom Modell erzeugte Vorschlaege, vom normalen Backend validiert.
- Sprachausgabe: echte Audio-Chunks und deren Audiotranskript. Nur wortgleich
  mit dem reservierten Text bestaetigte Ausgaben werden kanonisch gespeichert.
- Persistenz, Leitfadenreferenzen, Sequenzen und Abschluss: normale Anwendung.

## Was simuliert ist

Der Teilnehmer ist Anna Kern von der erfundenen Elbwerk Verpackungstechnik GmbH.
Die Antworten stammen aus festen erfundenen Fakten und werden automatisch als
`input_text` in die Realtime-Session eingespeist. Keine weitere KI schreibt die
Antworten und keine Interviewerfragen sind in der Fixture vorgegeben.

Die Teilnehmerseite spricht nicht: Mikrofon, STT, VAD und Unterbrechungen werden
hier nicht getestet. Audio wird automatisch empfangen und als lokale WAV-Datei
gespeichert, nicht im Browser abgespielt oder von einem Menschen bestaetigt.
Die bestehenden Realtime-Persistenz-Endpunkte kennzeichnen diese Turns technisch
als `openai_realtime`; der Datensatzname und die Berichte kennzeichnen deshalb
ausdruecklich die synthetische Herkunft. Es sind keine Forschungsdaten.

## Starten

Bei laufendem Backend und installierten lokalen Entwicklungsabhaengigkeiten:

```sh
node --import tsx scripts/run-realtime-synthetic-interview.ts --confirm-provider-calls
```

Der dauerhafte API-Key wird nicht gelesen oder an den Testclient ausgegeben.
Das Backend stellt wie fuer den Browser ein kurzlebiges Client-Secret aus.
Der Test lehnt ein anderes Realtime-Modell ab. Es entstehen echte API-Kosten.
Jeder Start erstellt ein neues benanntes synthetisches Interview; bestehende
Interviews, Profile und Leitfaden-Einstellungen bleiben unveraendert.

Falls der Backend-Port abweicht, kann `API_BASE_URL` gesetzt werden. Standard
ist `http://localhost:3100`. Der Test ist nicht Teil von `npm test`.

## Ergebnisse

Der abgeschlossene [echte Probelauf vom 1. Oktober 2026](2026-10-01T19-38-07-094Z-1cd3d41e/interview.md)
enthaelt 84 kanonische Turns: alle zwoelf Hauptfragen, 28 Leitfaden-Unterfragen,
eine frei erzeugte Klaerungsfrage und 41 Teilnehmerantworten sowie Begruessung
und Abschluss. Die 43 AI-Turns entsprechen wortgleich den empfangenen
Audiotranskripten; es gibt keine technischen Luecken oder doppelten Turn-IDs.
Der Datensatz ist finalisiert und noch nicht ausgewertet.

Konkretes Beispiel: Auf die unklare Antwort zur intern so genannten
"B-Freigabespur" fragte das Modell:

> Welche konkreten Aufgaben oder Entscheidungsbefugnisse gehören in dieser B-Freigabespur zu Ihrer Verantwortung?

Das ist keine vorgegebene Unterfrage: Die Verantwortungs-Hauptfrage hat im
Default-Leitfaden keine Unterfragen. Im eigentlichen Transkript und JSON bleibt
der originale Modellwortlaut unveraendert. Weitere Unterfragen dieses Durchlaufs
stammen aus dem Leitfaden und werden nicht als frei erzeugt ausgegeben.

Es wurden 99 Realtime-Responses angefordert, einschliesslich Rate-Limit-Versuchen.
Wegen der Wartezeiten erreichte die erste Verbindung das Laufzeitbudget; der
gleiche Datensatz wurde einmal ausdruecklich in einer zweiten Realtime-Verbindung
fortgesetzt. Der Bericht dokumentiert diese Unterbrechung. Es wurde kein neuer
Datensatz fuer die Fortsetzung erstellt und kein alter Turn erneut gespeichert.

Jeder Durchlauf speichert in einem eigenen Unterordner:

- `interview.md`: kanonisches Transkript, freie Nachfragen und Testgrenzen.
- `run.json`: finale Session, validierte Modellvorschlaege, Backend-Entscheidungen
  und Audio-Metadaten. Keine API-Keys oder privaten Modellgedanken.

Die tatsaechlichen WAV-Dateien liegen unter
`data/realtime-synthetic-audio/<Durchlauf>/` und sind nicht in Git enthalten.
Der Bericht verlinkt den passenden Datensatz in Eval Studio. Eine Auswertung
wird **nicht** gestartet; der Auswertungsbutton bleibt fuer den Nutzer.

Als freie Nachfragen werden nur unveraendert akzeptierte
`ask_clarification_question`-Vorschlaege gezaehlt, die nicht wortgleich mit einer
Leitfadenfrage sind. Wiederholungen und Backend-Fallbacks werden nicht gezaehlt.
Ob eine abweichende Formulierung inhaltlich nur eine vorhandene Unterfrage
wiederholt, wird am konkreten Dialog beurteilt. Eine passende Frage zur intern
genannten B-Freigabespur ist beispielsweise keine vorgegebene Unterfrage.

Modellentscheidungen koennen zwischen Durchlaeufen variieren. Die Simulation
erzwingt weder eine bestimmte Nachfrage noch einen bestimmten Score. Ein
abgebrochener oder fehlgeschlagener Lauf wird als solcher ausgewiesen.

## Grenzen Und Tests

Planning und Audio verwenden wie der Browser je maximal 512 Output-Tokens.
Automatische Antworten treffen schneller ein als menschliche Sprachturns; bei
einem bestaetigten Provider-Rate-Limit wird 65 Sekunden gewartet und derselbe
Request hoechstens zweimal erneut versucht. Andere Fehler werden nicht kaschiert.
Der Test ist auf 200 Responses, 80 Teilnehmerantworten und 15 Minuten begrenzt.

Das Laufzeitbudget gilt je Verbindung und wird vor einem neuen Response geprueft;
ein bereits laufender Request oder eine Rate-Limit-Wartezeit kann noch enden.
Falls ein eigener Testlauf dadurch unvollstaendig bleibt, kann er mit seiner
im Bericht angegebenen Run-ID ausdruecklich fortgesetzt werden:

```sh
node --import tsx scripts/run-realtime-synthetic-interview.ts --confirm-provider-calls --resume RUN_ID
```

Das verwendet denselben Datensatz und seine vorhandenen Antworten, aber eine
neue echte Realtime-Verbindung mit dem persistierten Interviewkontext. Der
Bericht behaelt bisherige Planungs-/Audioergebnisse und dokumentiert die Anzahl
der Verbindungen und fortgesetzte Abbrueche. Nur eigene laufende synthetische
Interviews mit passendem lokalen Bericht und unveraendertem Default-Leitfaden
koennen so fortgesetzt werden. Der interne Zustand `ending` wird im verwendeten
Session-Vertrag als `active` dargestellt; eine offene Abschlussausgabe wird
deshalb ebenfalls aus ihrer vorhandenen Reservierung fortgesetzt.
Es werden keine bestehenden Turns erneut
persistiert und keine API-Fehler durch einen Modellwechsel verdeckt.

`tests/realtime-simulation-client.test.ts` prueft deterministisch Verbindung,
Modellbindung, Item-IDs, Response-Zuordnung, Audio, Aufraeumen, Timeouts und
Rate-Limit-Recovery. `tests/realtime-synthetic-participant.test.ts` prueft die
Antwortquelle und ihre Zuordnung. Diese Unit Tests mocken den Provider; nur
die separat erzeugten Durchlaufberichte enthalten echte API-Ergebnisse.
`tests/realtime-simulation-cli.test.ts` prueft die explizite Kostenbestaetigung
und verhindert ungueltige Resume-Pfade vor Backend-/Providerzugriffen.
