const segmenter = new Intl.Segmenter('es-ES', { granularity: 'sentence' });

function voiceSentences(text) {
  if (text.length < 100) return [{ text, end: text.length }];
  const blocks = [];
  let start = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    const end = index + segment.length;
    // ICU can treat common abbreviations and numbered list labels as sentences.
    if (/(?:(?:\b(?:Sra?|Dra?|Dña|D|Srta|pág|núm|art|aprox|etc|a\. C|d\. C|p\. ej)|(?:^|\s)\p{Lu})\.|^\s*\d+\.)$/iu.test(segment.trim())) continue;
    if (!/[.!?…]["'»”’)]*$/u.test(segment.trim()) && end !== text.length) continue;
    const sentence = text.slice(start, end).trim();
    if (sentence) blocks.push({ text: sentence, end });
    start = end;
  }
  if (start < text.length) blocks.push({ text: text.slice(start).trim(), end: text.length });
  return blocks.length > 1 ? blocks : [{ text, end: text.length }];
}

module.exports = { voiceSentences };
