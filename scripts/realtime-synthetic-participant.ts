import type { InterviewGuide } from '@orgscience/contracts';

export const SYNTHETIC_PARTICIPANT_LABEL = 'Synthetischer Test: Elbwerk Druckluftausfall';

interface QuestionFixture {
  readonly question: string;
  readonly answer: string;
  readonly followUps: readonly string[];
  readonly clarification?: string;
}

const RESPONSIBILITY =
  'Ich verantworte Produktion, Instandhaltung, Lager und Versand. B-Spur bedeutet: Schicht- und Personaleinsatz sowie Ersatzbeschaffungen bis 25.000 Euro darf ich selbst freigeben. Hoehere Ausgaben und Vertragsaenderungen genehmigt die Geschaeftsfuehrung.';
const METRIC =
  'Gruen bedeutet mindestens 95 Prozent termingerechte Lieferungen der zuvor als kritisch markierten Kundenauftraege. An zehn von zwoelf Tagen erreichten wir diesen Grenzwert; ueber den ganzen Zeitraum waren es 96 Prozent. Die 72 Prozent beziehen sich dagegen auf die gesamte gefertigte Stueckzahl im Vergleich zu einer normalen gleich langen Produktionsperiode. Die Ampel erfasst also nicht den Gesamtausfall.';

// These are fictional source facts, not interviewer actions or suggested questions.
const FIXTURES: readonly QuestionFixture[] = [
  {
    question: 'Welche Rolle haben Sie innerhalb der Organisation?',
    answer:
      'Ich bin Anna Kern, seit 2021 Betriebsleiterin der frei erfundenen Elbwerk Verpackungstechnik GmbH. Wir fertigen Verpackungskomponenten und haben 180 Beschaeftigte.',
    followUps: [],
  },
  {
    question: 'Welche Verantwortung haben Sie innerhalb der Organisation?',
    answer: 'Bei mir laeuft das ueber unsere B-Freigabespur. So nennen wir das intern.',
    followUps: [],
    clarification: RESPONSIBILITY,
  },
  {
    question: 'Wie viele Mitarbeiter haben Sie unter sich?',
    answer:
      'Fuenf Teamleitungen berichten direkt an mich. Insgesamt arbeiten 84 Beschaeftigte in meinem Verantwortungsbereich, von 180 im gesamten Unternehmen.',
    followUps: [],
  },
  {
    question:
      'Was macht Ihre Organisation unter schwierigen Bedingungen, um ihre Position und Stabilit\u00e4t zu bewahren?',
    answer:
      'Beim Ausfall der zentralen Druckluftversorgung im April 2026 priorisierten wir kritische Kundenauftraege, nutzten eine kleine unabhaengige Linie und versandten Lagerware. Unsere Lieferampel war meist gruen, obwohl wir nur 72 Prozent der normalen Stueckzahl fertigten.',
    followUps: [
      'Am 7. April 2026 fiel unser Hauptkompressor wegen eines Lagerschadens aus. Zwei grosse Fertigungslinien verloren dadurch ihre Druckluftversorgung.',
      'Die kleine Linie mit eigener Versorgung, Qualitaetspruefung, Lager, Versand, Kundenservice und Verwaltung arbeiteten weiter.',
      'Die grossen Linien standen zuerst sechs Stunden still. Danach lief eine Linie gedrosselt; die zweite blieb drei Tage aus. 46 unkritische Auftraege kamen verspaetet, zwei wurden storniert.',
      'Die Belastung dauerte zwoelf Tage, vom 7. April bis zur Wiederherstellung am 19. April 2026.',
      'Unsere Lieferampel blieb an zehn von zwoelf Tagen gruen; zugleich erreichten wir nur 72 Prozent der normalen Stueckzahl.',
    ],
    clarification: METRIC,
  },
  {
    question:
      'Wie entwickelt Ihre Organisation unterschiedliche L\u00f6sungen, wenn sie mit schwierigen Herausforderungen konfrontiert ist?',
    answer:
      'Produktion, Einkauf und Instandhaltung prueften einen Mietkompressor, Fremdfertigung und Zusatzschichten auf der unabhaengigen kleinen Linie. Wir setzten alle drei Wege ein, aber nicht fuer alle Formate.',
    followUps: [
      'Wir entwickelten drei Optionen: einen Mietkompressor anschliessen, drei Produktformate extern fertigen lassen und die kleine Linie mit einer zweiten Schicht auslasten.',
      'Alle drei Optionen wurden eingesetzt: Mietkompressor am ersten Tag, Zusatzschicht ab dem zweiten Tag und Fremdfertigung ab dem vierten Tag.',
      'Produktion, Einkauf, Qualitaet und Vertrieb glichen um 8 und 15 Uhr eine gemeinsame Kapazitaetsliste ab. Ich gab Schichten frei; Qualitaet genehmigte die externen Formate.',
      'Der Mietkompressor war nach einem Geraetetausch nutzbar. Die kleine Linie konnte vier von acht Formaten verarbeiten, der Partner nur drei. Ein Format musste warten.',
    ],
  },
  {
    question:
      'Wie verh\u00e4lt sich Ihre Organisation, wenn sie Gefahr l\u00e4uft, etwas Wesentliches zu verlieren?',
    answer:
      'Gefaehrdet war der Liefervertrag mit unserem groessten Kunden. Wir reservierten Material und Kapazitaet fuer dessen kritische Auftraege und vereinbarten taegliche Teillieferungen. Den Vertrag erhielten wir, einzelne andere Auftraege gingen verloren.',
    followUps: [
      'Unser groesster Kunde drohte, einen jaehrlichen Liefervertrag ueber 1,2 Millionen Euro zu kuendigen, falls seine Produktion wegen fehlender Komponenten stillstand.',
      'Wir reservierten Lagerbestaende und Produktionskapazitaet fuer seine kritischen Auftraege, vereinbarten taegliche Teillieferungen und organisierten Expressfahrten.',
      'Diese Sondermassnahmen liefen vierzehn Tage, vom 7. bis zum 21. April, bis der Rueckstand kritischer Lieferungen abgearbeitet war.',
      'Der Liefervertrag blieb bestehen. Beim Kunden gab es keinen durch unsere Komponenten verursachten Stillstand, und wir mussten keine Arbeitsplaetze abbauen.',
      'Zwei andere Kunden stornierten Auftraege im Wert von zusammen 18.000 Euro. 46 weitere unkritische Auftraege wurden verspaetet ausgeliefert.',
    ],
  },
  {
    question:
      'Wie geht Ihre Organisation mit R\u00fcckschl\u00e4gen und Schwierigkeiten um, wenn der bisherige Weg gef\u00e4hrdet ist?',
    answer:
      'Am dritten Tag fiel auch der Mietkompressor aus. Wir fertigten auf der kleinen Linie weiter, nutzten Bestaende und Fremdfertigung und liessen das Mietgeraet austauschen. Die grosse Linie stand dabei weitere vier Stunden still.',
    followUps: [
      'Am dritten Stoerungstag fiel der erste Mietkompressor wegen einer defekten Steuerung aus; unser vorgesehener Uebergangsweg war damit erneut unterbrochen.',
      'Die kleine Linie, Lager und Versand liefen weiter. Fuer kritische Lieferungen nutzten wir vorhandene Bestaende; der externe Partner begann wie vereinbart am vierten Tag.',
      'Wir tauschten das Mietgeraet aus und liessen danach jede Schicht Druck und Temperatur protokollieren. Die Prioritaetenliste wurde nach verfuegbarem Bestand neu geordnet.',
      'Die wieder angelaufene grosse Linie stand vier Stunden still und erreichte danach rund 60 Prozent ihrer normalen Leistung. Insgesamt blieben wir im Stoerungszeitraum bei 72 Prozent der normalen Stueckzahl.',
    ],
  },
  {
    question: 'Wie handelt Ihre Organisation, wenn schnelles Handeln erforderlich ist?',
    answer:
      'Beim Kompressorausfall erkannte die Fruehschicht die Stoerung um 7:40 Uhr. Um 8:02 Uhr entschied ich die Verlagerung kritischer Auftraege; um 8:43 Uhr begann die erste angepasste Fertigung auf der kleinen Linie.',
    followUps: [
      'Zuletzt erforderte der Ausfall am 7. April sofortiges Handeln, weil um 10 Uhr die erste kritische Kundenlieferung bereitstehen musste.',
      'Zwischen Erkennen um 7:40 Uhr und meiner Entscheidung um 8:02 Uhr lagen 22 Minuten.',
      'Von der Entscheidung um 8:02 Uhr bis zum Beginn der umgeplanten Fertigung um 8:43 Uhr vergingen weitere 41 Minuten.',
      'Auf den Mietkompressor warteten wir sechs Stunden. Die Freigabe des Fremdfertigungsvertrags durch die Geschaeftsfuehrung dauerte 90 Minuten, weil die Zeichnungsberechtigung zunaechst unklar war.',
    ],
  },
  {
    question:
      'Wie entwickelt und nutzt Ihre Organisation Alternativen, um aus negativen Umst\u00e4nden handlungsf\u00e4hig oder st\u00e4rker hervorzugehen?',
    answer:
      'Wir kombinierten die kleine Linie mit Fremdfertigung und Mietdruckluft. Danach behielten wir den geprueften Fertigungspartner und einen Mietrahmenvertrag. Das verringert Abhaengigkeiten, kostet aber Geld und deckt nicht jedes Format ab.',
    followUps: [
      'Wir nutzten tatsaechlich die unabhaengige kleine Linie, Fremdfertigung fuer drei Formate und einen Mietkompressor fuer die grosse Linie.',
      'Die kleine Linie uebernahm kurzfristige Auftraege; der Partner fertigte Serien, und die Mietdruckluft hielt eine grosse Linie in Betrieb. Eine gemeinsame Liste verteilte Auftraege und Material.',
      'Vorher fertigten wir alles selbst an einem Standort. Danach konnten wir drei Formate an einen geprueften Partner abgeben und kurzfristig Mietdruckluft bestellen.',
      'Auch fuenf Monate spaeter bestehen der Mietrahmenvertrag, die Freigabe des Partners und eine monatlich aktualisierte Liste der extern fertigbaren Formate.',
      'Fremdfertigung ist etwa 18 Prozent teurer. Der Partner deckt nur drei von acht Formaten ab, die kleine Linie vier; ein Format bleibt ausschliesslich von der grossen Linie abhaengig.',
    ],
  },
  {
    question:
      'Wie passt Ihre Organisation ihr Handeln an, wenn sich die Situation ver\u00e4ndert und konkrete Ma\u00dfnahmen n\u00f6tig werden?',
    answer:
      'Als der Mietkompressor am dritten Tag ausfiel, verlagerten wir Personal und Material erneut auf die kleine Linie und passten Lieferzusagen an. Acht Beschaeftigte wechselten die Schicht; die Freigabe eines externen Formats dauerte aber einen Tag laenger als geplant.',
    followUps: [
      'Am dritten Tag mussten wir auf den Ausfall des Mietkompressors reagieren; die grosse Linie konnte fuer vier Stunden keine Auftraege fertigen.',
      'Acht Beschaeftigte wechselten zur kleinen Linie oder zum Versand. Einkauf beschaffte ein anderes Mietgeraet, und Vertrieb aenderte die Lieferzusagen fuer unkritische Auftraege.',
      'Die vier Bereiche stimmten die neue Verteilung in der gemeinsamen Lagebesprechung ab. Ich gab die Personalwechsel frei, die jeweiligen Teamleitungen bestaetigten Material und Schichtbesetzung.',
      'Die Qualitaetsfreigabe fuer ein externes Format war einen Tag verspaetet, weil eine Prueflehre erst zum Partner transportiert werden musste.',
    ],
  },
  {
    question:
      'Wie setzen sich die Besch\u00e4ftigten Ihrer Organisation in schwierigen Situationen daf\u00fcr ein, das Erforderliche zu tun?',
    answer:
      'Instandhaltung organisierte Ersatzgeraete, Produktion uebernahm Zusatzschichten, Lager und Versand bereiteten Teillieferungen vor. Teamleitungen verteilten Aufgaben mit Vertretungen. Bei Nachtschicht und Zeitarbeit waren die Einweisungen anfangs lueckenhaft.',
    followUps: [
      'Instandhaltung pruefte die Mietgeraete, Produktion besetzte die zweite Schicht, Lager stellte priorisierte Materialien bereit, Versand organisierte Teillieferungen und Vertrieb informierte Kunden.',
      'Die fuenf Teamleitungen trugen Verantwortliche und Vertretungen in eine Schichtliste ein. Bei der taeglichen Uebergabe bestaetigte jede Person ihre Aufgabe.',
      'Stammkraefte uebernahmen Umruesten und Pruefungen. Zeitarbeitskraefte halfen bei Verpackung und Materialtransport. Verwaltung unterstuetzte die Lieferlisten, konnte aber keine Maschinen bedienen.',
      'In der ersten Nachtschicht fehlte eine eingewiesene Vertretung fuer die Materialbuchung. Zeitarbeitskraefte mussten auf Einweisung warten; die Bestaende wurden erst morgens nachgetragen.',
    ],
  },
  {
    question:
      'Wie handelt Ihre Organisation gemeinsam mit ihren Besch\u00e4ftigten, wenn abgestimmtes Vorgehen erforderlich ist?',
    answer:
      'Produktion, Instandhaltung, Einkauf, Qualitaet, Versand und Vertrieb arbeiteten mit einer gemeinsamen Auftragsliste. Bei Lieferprioritaeten wurden Schichtvertretungen beteiligt. Zu Beginn versprach der Vertrieb jedoch Termine, die die Produktion nicht bestaetigt hatte.',
    followUps: [
      'Produktion, Instandhaltung, Einkauf, Qualitaet, Lager, Versand und Vertrieb mussten zusammenarbeiten. Fuer Zusatzschichten waren Personal und Betriebsrat beteiligt.',
      'Wir priorisierten zuerst Auftraege, deren Ausfall einen Kundenstillstand verursacht haette. Danach kamen vertragliche Termine. Teamleitungen und Schichtvertretungen prueften taeglich die gemeinsame Liste.',
      'Bei der zweiten Schicht schlug eine Schichtvertretung vor, zwei erfahrene Kraefte fuer das Umruesten zu behalten. Produktion passte den Plan an, Personal pruefte Ruhezeiten, und der Betriebsrat stimmte der Schichtregelung zu.',
      'Der Vertrieb versprach am ersten Tag zwei Termine ohne Bestaetigung der Produktion. Danach durfte er Lieferzusagen nur aus der freigegebenen Liste uebernehmen; nachts kamen Aktualisierungen anfangs noch verspaetet an.',
    ],
  },
];

interface AnswerSource {
  readonly answer: string;
  readonly clarification: string;
}

export class SyntheticParticipant {
  private readonly sources: ReadonlyMap<string, AnswerSource>;

  constructor(guide: InterviewGuide) {
    const expectedSections = ['Allgemeines', 'Robustness', 'Agility', 'Integrity'];
    if (
      guide.sourceLanguage !== 'de' ||
      guide.sections.map((section) => section.title).join('|') !== expectedSections.join('|')
    ) {
      throw new Error('The synthetic participant requires the canonical German nine-item guide.');
    }
    const questions = guide.sections.flatMap((section) => section.mainQuestions);
    if (questions.length !== FIXTURES.length) throw new Error('Unexpected main-question count.');
    const sources = new Map<string, AnswerSource>();
    for (const [index, question] of questions.entries()) {
      const fixture = FIXTURES[index];
      if (
        !fixture ||
        question.text !== fixture.question ||
        question.followUpQuestions.length !== fixture.followUps.length
      ) {
        throw new Error(`The synthetic fixture does not match guide question ${index + 1}.`);
      }
      const clarification = [fixture.answer, ...fixture.followUps, fixture.clarification ?? '']
        .filter(Boolean)
        .join(' ');
      sources.set(question.id, { answer: fixture.answer, clarification });
      for (const [followUpIndex, followUp] of question.followUpQuestions.entries()) {
        const answer = fixture.followUps[followUpIndex];
        if (!answer) throw new Error('Missing synthetic follow-up answer.');
        sources.set(followUp.id, { answer, clarification });
      }
    }
    this.sources = sources;
  }

  responseFor(questionId: string, turnType: string, missingAspect: string | null = null): string {
    const source = this.sources.get(questionId);
    if (!source) throw new Error(`No synthetic answer for guide question ${questionId}.`);
    if (turnType === 'clarification_question') {
      if (
        source.clarification.includes(METRIC) &&
        /ampel|gruen|gr\u00fcn|kennzahl|lieferquote|grenzwert/i.test(missingAspect ?? '')
      )
        return METRIC;
      return source.clarification;
    }
    return source.answer;
  }
}

export function buildSyntheticParticipantAnswers(guide: InterviewGuide): Map<string, string> {
  const participant = new SyntheticParticipant(guide);
  return new Map(
    guide.sections
      .flatMap((section) =>
        section.mainQuestions.flatMap((question) => [question, ...question.followUpQuestions]),
      )
      .map((question) => [question.id, participant.responseFor(question.id, 'main_question')]),
  );
}
