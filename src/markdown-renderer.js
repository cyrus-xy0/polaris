export function renderMarkdownToFeishuXml(markdown) {
  return parseMarkdownBlocks(markdown).map(renderBlockToFeishuXml).join("");
}

export function renderMarkdownToHtml(markdown) {
  return parseMarkdownBlocks(markdown).map(renderBlockToHtml).join("");
}

function parseMarkdownBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const { block, nextIndex } = parseTable(lines, index);
      blocks.push(block);
      index = nextIndex;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: Math.min(6, heading[1].length),
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isUnorderedListItem(trimmed)) {
      const items = [];
      while (index < lines.length && isUnorderedListItem(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (isOrderedListItem(trimmed)) {
      const items = [];
      while (index < lines.length && isOrderedListItem(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const candidate = lines[index].trim();
      if (!candidate) break;
      if (paragraphLines.length > 0 && startsBlock(lines, index)) break;
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function startsBlock(lines, index) {
  const trimmed = lines[index].trim();
  return (
    isMarkdownTableStart(lines, index) ||
    /^(#{1,6})\s+/.test(trimmed) ||
    isUnorderedListItem(trimmed) ||
    isOrderedListItem(trimmed)
  );
}

function parseTable(lines, startIndex) {
  const header = splitMarkdownTableRow(lines[startIndex]);
  let index = startIndex + 2;
  const rows = [];

  while (index < lines.length && isMarkdownTableRow(lines[index])) {
    rows.push(splitMarkdownTableRow(lines[index]));
    index += 1;
  }

  return {
    block: {
      type: "table",
      header,
      rows,
    },
    nextIndex: index,
  };
}

function isMarkdownTableStart(lines, index) {
  return isMarkdownTableRow(lines[index]) && isMarkdownTableSeparator(lines[index + 1]);
}

function isMarkdownTableRow(line) {
  return typeof line === "string" && line.includes("|") && splitMarkdownTableRow(line).length > 1;
}

function isMarkdownTableSeparator(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line ?? "").trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }

  cells.push(cell.trim());
  return cells;
}

function isUnorderedListItem(line) {
  return /^[-*+]\s+\S/.test(line);
}

function isOrderedListItem(line) {
  return /^\d+[.)]\s+\S/.test(line);
}

function renderBlockToFeishuXml(block) {
  if (block.type === "heading") {
    const level = Math.min(6, Math.max(1, block.level));
    return `<h${level}>${escapeXml(block.text)}</h${level}>`;
  }

  if (block.type === "table") {
    const header = `<thead><tr>${block.header.map((cell) => `<th background-color="light-gray">${escapeXml(cell)}</th>`).join("")}</tr></thead>`;
    const rows = block.rows
      .map((row) => `<tr>${row.map((cell) => `<td vertical-align="top">${escapeXml(cell)}</td>`).join("")}</tr>`)
      .join("");
    return `<table>${header}<tbody>${rows}</tbody></table>`;
  }

  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items
      .map((item) => (block.ordered ? `<li seq="auto">${escapeXml(item)}</li>` : `<li>${escapeXml(item)}</li>`))
      .join("");
    return `<${tag}>${items}</${tag}>`;
  }

  return `<p>${escapeXml(block.text)}</p>`;
}

function renderBlockToHtml(block) {
  if (block.type === "heading") {
    const level = Math.min(6, Math.max(1, block.level + 1));
    return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
  }

  if (block.type === "table") {
    const header = `<thead><tr>${block.header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
    const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
    return `<table>${header}<tbody>${rows}</tbody></table>`;
  }

  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<${tag}>${items}</${tag}>`;
  }

  return `<p>${escapeHtml(block.text)}</p>`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return escapeXml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
