import type { SupportedLocale } from '@orgscience/contracts';

const ENGLISH_MESSAGES: Readonly<Record<string, string>> = {
  'Dimensions-IDs müssen eindeutig sein.': 'Dimension IDs must be unique.',
  'Die Dimensionsreihenfolge ist ungültig.': 'The dimension order is invalid.',
  'Item-IDs müssen eindeutig sein.': 'Item IDs must be unique.',
  'Das Item verweist auf keine gültige Dimension.':
    'The item must reference an existing dimension.',
  'Die Itemreihenfolge ist ungültig.': 'The item order is invalid.',
  'Jede Dimension benötigt mindestens ein Item.': 'Every dimension needs at least one item.',
  'Items müssen nach Dimension und Reihenfolge gruppiert sein.':
    'Items must be grouped by dimension and item order.',
  'Dieses Feld darf nicht leer sein.': 'This field must not be blank.',
  'Die JSON-Datei überschreitet die maximale Größe von 20 MiB.':
    'The JSON file exceeds the maximum size of 20 MiB.',
  'Die JSON-Datei darf höchstens 20 MiB groß sein.': 'The JSON file must not exceed 20 MiB.',
  'Die Datei enthält kein gültiges JSON.': 'The file does not contain valid JSON.',
  'JSON-Syntax prüfen.': 'Check the JSON syntax.',
  'Too small: expected string to have >=1 characters': 'This field must not be blank.',
  'Too big: expected string to have <=20000 characters':
    'This field must not exceed 20,000 characters.',
  'Too small: expected number to be >=0': 'The value must be greater than or equal to 0.',
  'Invalid input: expected number, received NaN': 'This field must contain a finite number.',
  'Invalid input: expected number, received Infinity': 'This field must contain a finite number.',
};

const GERMAN_MESSAGES: Readonly<Record<string, string>> = {
  'Too small: expected string to have >=1 characters': 'Dieses Feld darf nicht leer sein.',
  'Too big: expected string to have <=20000 characters':
    'Dieses Feld darf höchstens 20.000 Zeichen enthalten.',
  'Too small: expected number to be >=0': 'Der Wert muss größer oder gleich 0 sein.',
  'Invalid input: expected number, received NaN': 'Dieses Feld muss eine endliche Zahl enthalten.',
  'Invalid input: expected number, received Infinity':
    'Dieses Feld muss eine endliche Zahl enthalten.',
  'A formula is required.': 'Ein Formelausdruck ist erforderlich.',
  'The formula exceeds 20,000 characters.': 'Die Formel darf höchstens 20.000 Zeichen enthalten.',
  'The formula exceeds 64 levels of nesting.':
    'Die Formel darf höchstens 64 Verschachtelungsebenen enthalten.',
  'The formula exceeds 4,096 syntax nodes.':
    'Die Formel darf höchstens 4.096 Syntaxknoten enthalten.',
  'The formula has invalid mathematical syntax.': 'Die mathematische Formelsyntax ist ungültig.',
  'Only numeric arithmetic and approved functions are allowed.':
    'Nur numerische Arithmetik und freigegebene Funktionen sind erlaubt.',
  'Only finite numeric literals are allowed outside references.':
    'Außerhalb von Referenzen sind nur endliche Zahlen erlaubt.',
  'Only unary plus and minus are allowed.': 'Als unäre Operatoren sind nur Plus und Minus erlaubt.',
  'Only +, -, *, /, and % are allowed.': 'Nur die Operatoren +, -, *, / und % sind erlaubt.',
  'Object access and dynamic function calls are forbidden.':
    'Objektzugriffe und dynamische Funktionsaufrufe sind nicht erlaubt.',
  'Reference functions require one quoted stable ID.':
    'Referenzfunktionen benötigen eine stabile ID in Anführungszeichen.',
  'The formula references an unknown item or dimension ID.':
    'Die Formel verweist auf eine unbekannte Item- oder Dimensions-ID.',
  'The formula calls an unapproved function.':
    'Die Formel ruft eine nicht freigegebene Funktion auf.',
  'A mathematical function has the wrong argument count.':
    'Eine mathematische Funktion hat die falsche Anzahl an Argumenten.',
  'Division or remainder by zero is undefined.':
    'Eine Division oder Restwertberechnung durch 0 ist nicht definiert.',
  'The calculation produced a non-finite value.':
    'Die Berechnung hat keinen endlichen Wert ergeben.',
  'Item scores must be integers from 1 through 7 or missing.':
    'Itemwerte müssen ganze Zahlen von 1 bis 7 sein oder fehlen.',
};

export function profileUiError(message: string, locale: SupportedLocale): string {
  return locale === 'en'
    ? (ENGLISH_MESSAGES[message] ?? message)
    : (GERMAN_MESSAGES[message] ?? message);
}
