// Заметки шага: что установщик сделал сам (убрал конфликт, снял ограничение). Показываются в окне рядом с приложением.
let sink: (text: string) => void = () => {};

export function setNoteSink(fn: (text: string) => void): void {
  sink = fn;
}

export function note(text: string): void {
  sink(text);
}
