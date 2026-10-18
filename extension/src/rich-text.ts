/**
 * Messages from the background and the server name commands in backticks
 * (`lexicon serve --pair`). Shown with textContent the backticks were literal;
 * this renders each backticked span as a <code> element instead, building
 * text nodes only, so a message (which may carry a server's error string)
 * can never inject markup. An unpaired backtick is kept as written.
 */
export function setMessage(el: HTMLElement, text: string): void {
  const doc = el.ownerDocument;
  const parts = text.split('`');
  // An even number of parts means an odd number of backticks: the last one
  // has no partner, so glue it back onto the trailing text.
  if (parts.length % 2 === 0) {
    const tail = parts.pop() ?? '';
    parts[parts.length - 1] += '`' + tail;
  }
  const nodes: Node[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (part !== '') nodes.push(doc.createTextNode(part));
    } else if (part === '') {
      nodes.push(doc.createTextNode('``'));
    } else {
      const code = doc.createElement('code');
      code.textContent = part;
      nodes.push(code);
    }
  });
  el.replaceChildren(...nodes);
}
