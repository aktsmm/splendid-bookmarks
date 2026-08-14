/** Text-only DOM helpers. Plan files are untrusted input, so nothing renders as HTML. */

export function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function clear(container) {
  container.replaceChildren();
  return container;
}

export function table(headers, rows) {
  const tableEl = document.createElement("table");
  const headRow = tableEl.createTHead().insertRow();
  for (const header of headers) {
    const cell = text("th", header);
    // Without an explicit scope, screen readers do not tie cells to headers.
    cell.scope = "col";
    headRow.appendChild(cell);
  }
  const body = tableEl.createTBody();
  for (const cells of rows) {
    const bodyRow = body.insertRow();
    for (const cell of cells) {
      bodyRow.appendChild(text("td", cell));
    }
  }
  return tableEl;
}

/** Selectable rows. The label wraps the box so the row text names the control. */
export function checkList(items, onToggle) {
  const list = document.createElement("ul");
  list.className = "check-list";
  for (const item of items) {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.checked;
    // Lets the page put focus back on the same row after it rebuilds the panel.
    box.dataset.id = item.id;
    box.addEventListener("change", () => onToggle(item.id, box.checked));
    label.appendChild(box);
    label.appendChild(text("span", item.label));
    // A real text node, not just a CSS gap: the accessible name is computed from
    // the text content, so without this the title and the path are read as one.
    if (item.detail) {
      label.appendChild(document.createTextNode(" "));
      label.appendChild(text("span", item.detail, "muted"));
    }
    row.appendChild(label);
    list.appendChild(row);
  }
  return list;
}

/** One-of-many rows sharing `groupName`, for picking the single copy to keep. */
export function keepList(items, groupName, label, onPick) {
  const list = document.createElement("ul");
  list.className = "check-list";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", label);
  for (const item of items) {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "radio";
    box.name = groupName;
    box.checked = item.checked;
    box.dataset.id = item.id;
    box.addEventListener("change", () => onPick(item.id));
    label.appendChild(box);
    label.appendChild(text("span", item.label));
    if (item.detail) {
      label.appendChild(document.createTextNode(" "));
      label.appendChild(text("span", item.detail, "muted"));
    }
    row.appendChild(label);
    list.appendChild(row);
  }
  return list;
}

/** An inline control the panel owns; panels are rebuilt, so it carries its own handler. */
export function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "inline-action";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

export function applyStaticTranslations(root, translate) {
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = translate(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    node.title = translate(node.dataset.i18nTitle);
  }
}
