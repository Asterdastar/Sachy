const STORAGE_KEY = "chess-tournament-v1";
const $ = (selector) => document.querySelector(selector);

let tournament = loadTournament();
let selectedRound = 0;
let activeView = "tournament";
let pdfExportMode = "round";
let toastTimer;

function loadTournament() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error("Turnaj se nepodařilo načíst z úložiště.", error);
    return null;
  }
}

function saveTournament() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tournament));
  } catch (error) {
    console.error("Turnaj se nepodařilo uložit.", error);
    showToast("Uložení se nezdařilo. Zkontrolujte volné místo v prohlížeči.");
  }
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function activePlayers() {
  return tournament.players.filter((player) => !player.withdrawn);
}

function findPlayer(id) {
  return tournament.players.find((player) => player.id === id);
}

function getMatches(round) {
  return round?.matches ?? [];
}

function resultScore(result, playerIsWhite) {
  if (result === "1-0") return playerIsWhite ? 1 : 0;
  if (result === "0-1") return playerIsWhite ? 0 : 1;
  if (result === "½-½") return 0.5;
  return null;
}

function calculateStandings(roundLimit = tournament.rounds.length) {
  const stats = new Map(tournament.players.map((player) => [player.id, {
    player, points: 0, opponents: [], white: 0, black: 0, byes: 0,
  }]));
  const includedRounds = tournament.rounds.slice(0, roundLimit);
  for (const round of includedRounds) {
    for (const match of getMatches(round)) {
      if (match.bye) {
        const byeStats = stats.get(match.whiteId);
        if (byeStats) {
          byeStats.points += 1;
          byeStats.byes += 1;
        }
        continue;
      }
      if (!match.result) continue;
      const whiteStats = stats.get(match.whiteId);
      const blackStats = stats.get(match.blackId);
      if (!whiteStats || !blackStats) continue;
      const whitePoints = resultScore(match.result, true);
      whiteStats.points += whitePoints;
      blackStats.points += resultScore(match.result, false);
      whiteStats.white += 1;
      blackStats.black += 1;
      whiteStats.opponents.push(match.blackId);
      blackStats.opponents.push(match.whiteId);
    }
  }
  for (const item of stats.values()) {
    item.buchholz = item.opponents.reduce((sum, opponentId) => sum + (stats.get(opponentId)?.points ?? 0), 0);
  }
  const headToHead = (first, second) => {
    let firstScore = 0;
    let played = false;
    for (const round of includedRounds) {
      for (const match of getMatches(round)) {
        if (match.bye || !match.result) continue;
        const isFirstWhite = match.whiteId === first.player.id && match.blackId === second.player.id;
        const isFirstBlack = match.blackId === first.player.id && match.whiteId === second.player.id;
        if (isFirstWhite || isFirstBlack) {
          played = true;
          firstScore += resultScore(match.result, isFirstWhite);
        }
      }
    }
    return played ? firstScore > 0.5 ? -1 : firstScore < 0.5 ? 1 : 0 : 0;
  };
  return [...stats.values()].sort((a, b) =>
    b.points - a.points ||
    headToHead(a, b) ||
    b.buchholz - a.buchholz ||
    a.player.seed - b.player.seed ||
    a.player.name.localeCompare(b.player.name, "cs", { sensitivity: "base" }));
}

function getPairHistory() {
  const pairs = new Set();
  for (const round of tournament.rounds) {
    for (const match of getMatches(round)) {
      if (!match.bye) pairs.add(pairKey(match.whiteId, match.blackId));
    }
  }
  return pairs;
}

function pairKey(firstId, secondId) {
  return [firstId, secondId].sort().join("|");
}

function colorBalance(playerId) {
  let balance = 0;
  for (const round of tournament.rounds) {
    for (const match of getMatches(round)) {
      if (match.bye) continue;
      if (match.whiteId === playerId) balance += 1;
      if (match.blackId === playerId) balance -= 1;
    }
  }
  return balance;
}

function pairingCost(first, second, firstIsWhite) {
  const firstWhite = firstIsWhite ? 1 : -1;
  const secondWhite = -firstWhite;
  const firstBalance = colorBalance(first.player.id);
  const secondBalance = colorBalance(second.player.id);
  const colorCost = Math.max(0, firstBalance + firstWhite) ** 2 +
    Math.max(0, -(firstBalance + firstWhite)) ** 2 +
    Math.max(0, secondBalance + secondWhite) ** 2 +
    Math.max(0, -(secondBalance + secondWhite)) ** 2;
  const scoreCost = Math.abs(first.points - second.points) * 5;
  const seedColorBias = firstIsWhite ? 0 : 0.01;
  return colorCost + scoreCost + seedColorBias;
}

function pairPlayers(players) {
  const history = getPairHistory();
  const memo = new Map();
  function solve(remaining) {
    if (remaining.length === 0) return { cost: 0, matches: [] };
    const key = remaining.map((item) => item.player.id).sort().join(",");
    if (memo.has(key)) return memo.get(key);
    const first = remaining[0];
    let best = null;
    for (let index = 1; index < remaining.length; index += 1) {
      const second = remaining[index];
      if (history.has(pairKey(first.player.id, second.player.id))) continue;
      const rest = remaining.filter((_, position) => position !== 0 && position !== index);
      const tail = solve(rest);
      if (!tail) continue;
      for (const firstIsWhite of [true, false]) {
        const candidate = {
          cost: tail.cost + pairingCost(first, second, firstIsWhite),
          matches: [{
            whiteId: firstIsWhite ? first.player.id : second.player.id,
            blackId: firstIsWhite ? second.player.id : first.player.id,
            result: null,
          }, ...tail.matches],
        };
        if (!best || candidate.cost < best.cost) best = candidate;
      }
    }
    memo.set(key, best);
    return best;
  }
  return solve(players);
}

function makeNextRound() {
  if (tournament.rounds.length >= tournament.maxRounds) {
    showToast("Turnaj už dosáhl nastaveného počtu kol.");
    return;
  }
  if (tournament.rounds.length && !tournament.rounds.at(-1).complete) {
    showToast("Nejdříve zadejte všechny výsledky předchozího kola.");
    return;
  }
  const active = activePlayers();
  if (active.length < 2) {
    showToast("Pro losování jsou potřeba alespoň dva aktivní hráči.");
    return;
  }
  const standings = calculateStandings();
  const scores = new Map(standings.map((item) => [item.player.id, item]));
  let byePlayer = tournament.nextByeId ? findPlayer(tournament.nextByeId) : null;
  if (byePlayer && (byePlayer.withdrawn || !active.some((player) => player.id === byePlayer.id))) byePlayer = null;
  if (!byePlayer && active.length % 2 === 1) {
    const byeCandidates = [...active].sort((a, b) =>
      Number(scores.get(a.id)?.points ?? 0) - Number(scores.get(b.id)?.points ?? 0) ||
      Number(scores.get(b.id)?.buchholz ?? 0) - Number(scores.get(a.id)?.buchholz ?? 0) ||
      Number((scores.get(b.id)?.byes ?? 0) > 0) - Number((scores.get(a.id)?.byes ?? 0) > 0) ||
      b.seed - a.seed);
    byePlayer = byeCandidates.find((player) => !(scores.get(player.id)?.byes)) ?? byeCandidates[0];
  }
  tournament.nextByeId = null;
  const playersToPair = active
    .filter((player) => player.id !== byePlayer?.id)
    .map((player) => scores.get(player.id))
    .sort((a, b) => b.points - a.points || b.buchholz - a.buchholz || a.player.seed - b.player.seed);
  const pairing = pairPlayers(playersToPair);
  if (!pairing) {
    showToast("Bez opakování soupeřů už nelze všechny hráče spárovat. Upravte účastníky nebo výsledky.");
    return;
  }
  const matches = pairing.matches;
  if (byePlayer) matches.push({ whiteId: byePlayer.id, blackId: null, result: "bye", bye: true });
  tournament.rounds.push({
    number: tournament.rounds.length + 1,
    matches,
    complete: false,
  });
  selectedRound = tournament.rounds.length - 1;
  saveTournament();
  render();
}

function isRoundComplete(round) {
  return round.matches.every((match) => match.bye || Boolean(match.result));
}

function displayDate(date) {
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "long", year: "numeric" }).format(parsed);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function pdfRoundRows(round) {
  if (!round) return [];
  const scores = new Map(calculateStandings(Math.max(0, round.number - 1)).map((item) => [item.player.id, item.points]));
  return round.matches.map((match, index) => {
    const white = findPlayer(match.whiteId);
    if (match.bye) {
      return [
        "",
        String(white?.seed ?? ""),
        white?.name ?? "Odebraný hráč",
        formatPdfPoints(scores.get(white?.id) ?? 0),
        "",
        "",
        "Volno",
        "",
      ];
    }
    const black = findPlayer(match.blackId);
    return [
      String(index + 1),
      String(white?.seed ?? "—"),
      white?.name ?? "Odebraný hráč",
      formatPdfPoints(scores.get(white?.id) ?? 0),
      match.result ? match.result.replace("-", " : ") : "—",
      formatPdfPoints(scores.get(black?.id) ?? 0),
      black?.name ?? "Odebraný hráč",
      String(black?.seed ?? "—"),
    ];
  });
}

function formatPdfPoints(points) {
  return new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(points);
}

function drawPdfTable(context, options) {
  const { x, y, width, headers, rows, weights, bottom = 1510, headerHeight = 38 } = options;
  const rowHeight = Math.min(34, Math.max(17, (bottom - y - headerHeight) / Math.max(rows.length, 1)));
  const fontSize = Math.max(9, Math.min(16, rowHeight * 0.48));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const columnWidths = weights.map((weight) => width * weight / totalWeight);
  context.fillStyle = "#eeeeee";
  context.fillRect(x, y, width, headerHeight);
  context.strokeStyle = "#111111";
  context.lineWidth = 1.5;
  context.strokeRect(x, y, width, headerHeight + rowHeight * rows.length);
  context.font = "bold 15px Arial, sans-serif";
  context.fillStyle = "#000000";
  let columnX = x;
  headers.forEach((header, index) => {
    if (index) {
      context.beginPath();
      context.moveTo(columnX, y);
      context.lineTo(columnX, y + headerHeight + rowHeight * rows.length);
      context.stroke();
    }
    context.textAlign = options.headerAlignments?.[index] ?? "left";
    context.textBaseline = "middle";
    const padding = context.textAlign === "center" ? 4 : 9;
    const headerTextX = context.textAlign === "center"
      ? columnX + columnWidths[index] / 2
      : context.textAlign === "right"
        ? columnX + columnWidths[index] - padding
        : columnX + padding;
    context.fillText(header, headerTextX, y + headerHeight / 2, columnWidths[index] - padding * 2);
    columnX += columnWidths[index];
  });
  context.beginPath();
  context.moveTo(x, y + headerHeight);
  context.lineTo(x + width, y + headerHeight);
  context.stroke();
  context.font = `${fontSize}px Arial, sans-serif`;
  rows.forEach((row, rowIndex) => {
    const rowY = y + headerHeight + rowIndex * rowHeight;
    if (rowIndex) {
      context.beginPath();
      context.moveTo(x, rowY);
      context.lineTo(x + width, rowY);
      context.stroke();
    }
    let textX = x;
    row.forEach((value, columnIndex) => {
      context.textAlign = options.alignments?.[columnIndex] ?? (columnIndex === 0 ? "center" : "left");
      const padding = context.textAlign === "center" ? 4 : 9;
      const textXPosition = context.textAlign === "center"
        ? textX + columnWidths[columnIndex] / 2
        : context.textAlign === "right"
          ? textX + columnWidths[columnIndex] - padding
          : textX + padding;
      context.fillText(String(value), textXPosition, rowY + rowHeight / 2, columnWidths[columnIndex] - padding * 2);
      textX += columnWidths[columnIndex];
    });
  });
}

function pdfStandingsRows(roundLimit) {
  return calculateStandings(roundLimit).map((item, index) => [
    String(index + 1),
    String(item.player.seed),
    item.player.name,
    formatPdfPoints(item.points),
    formatPdfPoints(item.buchholz),
  ]);
}

function makePdfPreview() {
  const canvas = document.createElement("canvas");
  canvas.width = 1131;
  canvas.height = 1600;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Prohlížeč nepodporuje vytvoření náhledu PDF.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  const left = 72;
  const right = canvas.width - 72;
  const isRoundOnly = pdfExportMode === "round";
  const isStandingsOnly = pdfExportMode === "standings";
  const selectedRoundData = tournament.rounds[selectedRound];
  const title = tournament.name;
  const centerText = (text, y, font) => {
    context.font = font;
    context.textAlign = "center";
    context.fillText(text, canvas.width / 2, y, right - left);
    context.textAlign = "left";
  };
  centerText(title, 75, "bold 36px Arial, sans-serif");
  const meta = [displayDate(tournament.date), tournament.location, tournament.organizer].filter(Boolean).join("  ·  ");
  centerText(meta || "Šachový turnaj · švýcarský systém", 108, "16px Arial, sans-serif");
  context.strokeStyle = "#000000";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(left, 132);
  context.lineTo(right, 132);
  context.stroke();

  if (isRoundOnly) {
    const heading = selectedRoundData ? `PÁROVÁNÍ · KOLO ${selectedRoundData.number}` : "PÁROVÁNÍ";
    centerText(heading, 172, "bold 20px Arial, sans-serif");
    const headers = ["Šach.", "St.č.", "White", "Body", "Výsl.", "Body", "Black", "St.č."];
    const rows = pdfRoundRows(selectedRoundData);
    if (!rows.length) rows.push(["", "", "Zatím bez rozlosovaného kola", "", "", "", "", ""]);
    const tableWidth = 990;
    drawPdfTable(context, {
      x: (canvas.width - tableWidth) / 2, y: 190, width: tableWidth, headers, rows,
      weights: [0.55, 0.55, 1.8, 0.65, 0.75, 0.65, 1.8, 0.55],
      headerAlignments: ["center", "center", "left", "center", "center", "center", "left", "center"],
      alignments: ["center", "center", "left", "center", "center", "center", "left", "center"],
    });
  } else if (isStandingsOnly) {
    const through = selectedRoundData ? selectedRoundData.number : selectedRound + 1;
    centerText(`POŘADÍ PO ${through}. KOLE`, 172, "bold 20px Arial, sans-serif");
    const rows = pdfStandingsRows(Math.min(selectedRound + 1, tournament.rounds.length));
    if (!rows.length) rows.push(["—", "", "Zatím bez hráčů", "0", "0"]);
    const tableWidth = 900;
    drawPdfTable(context, {
      x: (canvas.width - tableWidth) / 2, y: 190, width: tableWidth,
      headers: ["Poř.", "St.č.", "Jméno", "Body", "BH:GP"], rows,
      weights: [0.7, 0.7, 2.2, 0.8, 0.8], headerAlignments: ["left", "left", "left", "left", "left"],
      alignments: ["left", "left", "left", "left", "left"],
    });
  }
  return canvas.toDataURL("image/jpeg", 0.94);
}

function buildPdfBlob(jpegDataUrl) {
  const jpegBytes = Uint8Array.from(atob(jpegDataUrl.split(",")[1]), (character) => character.charCodeAt(0));
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let byteLength = 0;
  const append = (bytes) => {
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  append(encoder.encode("%PDF-1.4\n%ChessTournament\n"));
  const objects = [
    encoder.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encoder.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encoder.encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"),
  ];
  objects.forEach((object) => {
    offsets.push(byteLength);
    append(object);
  });
  offsets.push(byteLength);
  append(encoder.encode(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1600 /Height 1131 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`));
  append(jpegBytes);
  append(encoder.encode("\nendstream\nendobj\n"));
  const pageContent = encoder.encode("q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n");
  offsets.push(byteLength);
  append(encoder.encode(`5 0 obj\n<< /Length ${pageContent.length} >>\nstream\n`));
  append(pageContent);
  append(encoder.encode("endstream\nendobj\n"));
  const xrefOffset = byteLength;
  const xref = ["xref\n0 6\n0000000000 65535 f \n"];
  for (let index = 1; index < offsets.length; index += 1) {
    xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  xref.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  append(encoder.encode(xref.join("")));
  return new Blob(chunks, { type: "application/pdf" });
}

function pdfFileName() {
  const safeName = tournament.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "turnaj";
  if (pdfExportMode === "round") return `${safeName}-kolo-${tournament.rounds[selectedRound]?.number ?? selectedRound + 1}.pdf`;
  return `${safeName}-poradi-po-${selectedRound + 1}-kole.pdf`;
}

function openPdfPreview(mode) {
  if (!tournament) return;
  if ((mode === "round" || mode === "standings") && !tournament.rounds.length) return;
  pdfExportMode = mode;
  try {
    const image = makePdfPreview();
    $("#pdf-preview-image").src = image;
    $("#pdf-dialog-title").textContent = mode === "round"
      ? `PDF · párování kola ${tournament.rounds[selectedRound].number}`
      : `PDF · pořadí po ${selectedRound + 1}. kole`;
    $("#pdf-dialog").showModal();
  } catch (error) {
    console.error("Náhled PDF se nepodařilo vytvořit.", error);
    showToast("Náhled PDF se nepodařilo vytvořit.");
  }
}

function downloadPdf() {
  try {
    const blob = buildPdfBlob(makePdfPreview());
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = pdfFileName();
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error("PDF se nepodařilo stáhnout.", error);
    showToast("PDF se nepodařilo vytvořit ani stáhnout.");
  }
}

function render() {
  const hasTournament = Boolean(tournament);
  $("#empty-state").hidden = hasTournament;
  $("#tournament-app").hidden = !hasTournament;
  if (!hasTournament) {
    activeView = "tournament";
    return;
  }
  $("#tournament-dashboard").hidden = activeView !== "tournament";
  $("#players-screen").hidden = activeView !== "players";
  $("#tournament-title").textContent = tournament.name;
  $("#tournament-season").textContent = tournament.organizer ? `· ${tournament.organizer}` : "";
  $("#tournament-meta").textContent = [displayDate(tournament.date), tournament.location].filter(Boolean).join(" · ");
  const standings = calculateStandings();
  const top = standings[0];
  const active = activePlayers();
  $("#stat-players").textContent = active.length;
  $("#stat-rounds").innerHTML = `${tournament.rounds.length} <i>/ ${tournament.maxRounds}</i>`;
  $("#stat-leader").textContent = top?.player.name ?? "—";
  $("#stat-leader-points").textContent = top ? `${top.points} bodů` : "zatím bez výsledků";
  $("#player-count").textContent = tournament.players.length;
  $("#heading-player-count").textContent = tournament.players.length;
  $("#players-tournament-name").textContent = tournament.name;
  const rounds = tournament.rounds;
  if (selectedRound >= rounds.length) selectedRound = Math.max(0, rounds.length - 1);
  renderRoundTabs();
  renderRound();
  renderPlayers();
  const standingsThrough = tournament.rounds.length ? selectedRound + 1 : 0;
  $("#standings-title").textContent = standingsThrough ? `Pořadí po ${standingsThrough}. kole` : "Pořadí hráčů";
  renderStandings(calculateStandings(standingsThrough));
  renderStandings(calculateStandings(), $("#players-standings-body"));
  $("#selected-round-print").disabled = !tournament.rounds.length;
  const standingsPdfButton = $("#selected-standings-pdf");
  standingsPdfButton.disabled = !tournament.rounds.length;
  standingsPdfButton.textContent = standingsThrough ? `PDF pořadí po ${standingsThrough}. kole` : "Pořadí do PDF";
  const nextButton = $("#next-round-button");
  if (!rounds.length) nextButton.textContent = "＋  Vytvořit 1. kolo";
  else if (rounds.length >= tournament.maxRounds) nextButton.textContent = "Turnaj dokončen";
  else nextButton.textContent = "＋  Vytvořit další kolo";
  nextButton.disabled = rounds.length >= tournament.maxRounds || (rounds.length > 0 && !rounds.at(-1).complete) || active.length < 2;
}

function renderRoundTabs() {
  const container = $("#round-tabs");
  if (!tournament.rounds.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = tournament.rounds.map((round, index) =>
    `<button class="round-tab ${index === selectedRound ? "active" : ""}" type="button" data-round="${index}">KOLO ${round.number}${round.complete ? " · ✓" : ""}</button>`
  ).join("");
  container.querySelectorAll("[data-round]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedRound = Number(button.dataset.round);
      render();
    });
  });
}

function renderRound() {
  const container = $("#round-content");
  const round = tournament.rounds[selectedRound];
  if (!round) {
    container.innerHTML = `<div class="empty-round"><strong>Turnaj může začít</strong>Přidejte alespoň dva hráče a vytvořte první kolo.</div>`;
    return;
  }
  const complete = isRoundComplete(round);
  round.complete = complete;
  const finished = round.matches.filter((match) => match.bye || match.result).length;
  const matchRows = round.matches.map((match, index) => {
    const white = findPlayer(match.whiteId);
    if (match.bye) {
      return `<tr><td class="board-number">—</td><td class="seed">${white?.seed ?? "—"}</td><td class="player-name">${escapeHtml(white?.name ?? "Odebraný hráč")}</td><td class="bye-cell" colspan="3">VOLNO · 1 BOD</td></tr>`;
    }
    const black = findPlayer(match.blackId);
    return `<tr>
      <td class="board-number">${index + 1}</td>
      <td class="seed">${white?.seed ?? "—"}</td>
      <td class="player-name">${escapeHtml(white?.name ?? "Odebraný hráč")}</td>
      <td><select class="result-select" aria-label="Upravit výsledek šachovnice ${index + 1}" data-match="${index}">
        <option value="" ${!match.result ? "selected" : ""}>Výsledek</option>
        <option value="1-0" ${match.result === "1-0" ? "selected" : ""}>1 : 0</option>
        <option value="½-½" ${match.result === "½-½" ? "selected" : ""}>½ : ½</option>
        <option value="0-1" ${match.result === "0-1" ? "selected" : ""}>0 : 1</option>
      </select></td>
      <td class="player-name">${escapeHtml(black?.name ?? "Odebraný hráč")}</td>
      <td class="seed">${black?.seed ?? "—"}</td>
    </tr>`;
  }).join("");
  container.innerHTML = `
    <div class="round-summary"><span>Kolo ${round.number} · ${round.matches.length} ${round.matches.length === 1 ? "partie" : "partií"}</span><span>${complete ? "KOLO DOKONČENO" : `${finished} / ${round.matches.length} výsledků`}</span></div>
    <div class="table-wrap"><table class="pairings-table">
      <thead><tr><th>ŠACHOVNICE</th><th>POŘ.</th><th>BÍLÉ</th><th>VÝSLEDEK</th><th>ČERNÉ</th><th>POŘ.</th></tr></thead>
      <tbody>${matchRows}</tbody>
    </table></div>`;
  container.querySelectorAll("[data-match]").forEach((select) => {
    select.addEventListener("change", () => {
      round.matches[Number(select.dataset.match)].result = select.value || null;
      round.complete = isRoundComplete(round);
      saveTournament();
      render();
    });
  });
}

function renderPlayers() {
  const container = $("#player-list");
  const rows = tournament.players.map((player) => {
    const byeLabel = tournament.nextByeId === player.id ? "Zrušit volno" : "Přidělit volno";
    return `<tr class="${player.withdrawn ? "is-withdrawn" : ""}">
      <td class="players-seed">${player.seed}</td>
      <td><input class="player-name-input" type="text" maxlength="70" value="${escapeHtml(player.name)}" aria-label="Jméno hráče ${player.seed}" data-player-id="${player.id}"></td>
      <td class="players-actions">
        ${!player.withdrawn ? `<button class="mini-button" type="button" data-bye="${player.id}" aria-label="${byeLabel}" title="${byeLabel}">☝</button>` : ""}
        <button class="mini-button" type="button" data-withdraw="${player.id}" aria-label="${player.withdrawn ? "Vrátit hráče" : "Odhlásit hráče"}" title="${player.withdrawn ? "Vrátit" : "Odhlásit"}">${player.withdrawn ? "↶" : "×"}</button>
      </td>
    </tr>`;
  }).join("");
  container.innerHTML = `${rows}<tr class="player-entry-row">
    <td class="players-seed">＋</td>
    <td><input class="player-name-input new-player-input" type="text" maxlength="70" placeholder="Zadejte jméno…" aria-label="Nový hráč"></td>
    <td class="players-actions"></td>
  </tr>`;
  container.querySelectorAll("[data-player-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const player = findPlayer(input.dataset.playerId);
      if (!player) return;
      const name = input.value.trim();
      if (!name) {
        input.value = player.name;
        showToast("Jméno hráče nemůže zůstat prázdné.");
        return;
      }
      player.name = name;
      saveTournament();
      renderRound();
      renderStandings(calculateStandings(tournament.rounds.length ? selectedRound + 1 : 0));
      renderStandings(calculateStandings(), $("#players-standings-body"));
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const inputs = [...container.querySelectorAll(".player-name-input")];
      inputs[inputs.indexOf(input) + 1]?.focus();
    });
  });
  const newInput = container.querySelector(".new-player-input");
  newInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addPlayer(newInput.value);
  });
  container.querySelectorAll("[data-withdraw]").forEach((button) => button.addEventListener("click", () => toggleWithdrawal(button.dataset.withdraw)));
  container.querySelectorAll("[data-bye]").forEach((button) => button.addEventListener("click", () => toggleBye(button.dataset.bye)));
}

function addPlayer(name) {
  const cleanedName = name.trim();
  if (!cleanedName || !tournament) return;
  const nextSeed = Math.max(0, ...tournament.players.map((player) => player.seed)) + 1;
  tournament.players.push({ id: createId(), name: cleanedName, seed: nextSeed, withdrawn: false });
  saveTournament();
  render();
  $("#player-list .new-player-input").focus();
}

function showPlayersScreen() {
  if (!tournament) return;
  activeView = "players";
  $("#tournament-dashboard").hidden = true;
  $("#players-screen").hidden = false;
}

function showTournamentDashboard() {
  activeView = "tournament";
  $("#players-screen").hidden = true;
  $("#tournament-dashboard").hidden = false;
}

function renderStandings(standings, tbody = $("#standings-body")) {
  if (!standings.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-round">Přidejte hráče a pořadí se zobrazí zde.</td></tr>`;
    return;
  }
  tbody.innerHTML = standings.map((item, index) => `<tr>
    <td class="standing-rank ${index < 3 ? "top-rank" : ""}">${String(index + 1).padStart(2, "0")}</td>
    <td class="player-name ${item.player.withdrawn ? "withdrawn" : ""}">${escapeHtml(item.player.name)}${item.player.withdrawn ? " <span class='color-tag'>ODHLÁŠEN</span>" : ""}</td>
    <td class="numeric points">${item.points}</td>
  </tr>`).join("");
}

function toggleWithdrawal(playerId) {
  const player = findPlayer(playerId);
  if (!player) return;
  player.withdrawn = !player.withdrawn;
  if (player.withdrawn && tournament.nextByeId === player.id) tournament.nextByeId = null;
  saveTournament();
  render();
}

function toggleBye(playerId) {
  if (tournament.rounds.length && !tournament.rounds.at(-1).complete) {
    showToast("Volné kolo lze přidělit až po dokončení aktuálního kola.");
    return;
  }
  if (activePlayers().length % 2 === 0 && tournament.nextByeId !== playerId) {
    showToast("Ruční volné kolo lze přidělit při lichém počtu aktivních hráčů.");
    return;
  }
  tournament.nextByeId = tournament.nextByeId === playerId ? null : playerId;
  saveTournament();
  render();
}

function openTournamentDialog(edit = false) {
  const form = $("#tournament-form");
  form.reset();
  $("#tournament-dialog-title").textContent = edit ? "Upravit turnaj" : "Nový turnaj";
  if (edit && tournament) {
    form.elements.name.value = tournament.name;
    form.elements.organizer.value = tournament.organizer ?? "";
    form.elements.location.value = tournament.location ?? "";
    form.elements.date.value = tournament.date;
    form.elements.rounds.value = tournament.maxRounds;
  } else {
    form.elements.date.value = new Date().toISOString().slice(0, 10);
    form.elements.rounds.value = 5;
  }
  $("#tournament-dialog").showModal();
}

$("#new-tournament-button").addEventListener("click", () => openTournamentDialog(false));
$("#empty-create-button").addEventListener("click", () => openTournamentDialog(false));
$("#edit-tournament-button").addEventListener("click", () => openTournamentDialog(true));
$("#open-players-button").addEventListener("click", showPlayersScreen);
$("#back-to-tournament-button").addEventListener("click", showTournamentDashboard);
$("#add-player-button").addEventListener("click", () => $("#player-list .new-player-input").focus());
$("#next-round-button").addEventListener("click", makeNextRound);
$("#selected-round-print").addEventListener("click", () => openPdfPreview("round"));
$("#selected-standings-pdf").addEventListener("click", () => openPdfPreview("standings"));
$("#download-pdf-button").addEventListener("click", downloadPdf);
$("#print-pdf-preview-button").addEventListener("click", () => {
  document.body.classList.add("printing-pdf-preview");
  window.print();
});
window.addEventListener("afterprint", () => document.body.classList.remove("printing-pdf-preview"));
$("#close-tournament-button").addEventListener("click", () => {
  if (!confirm("Ukončit turnaj? Jeho výsledky se odstraní z tohoto prohlížeče.")) return;
  tournament = null;
  selectedRound = 0;
  localStorage.removeItem(STORAGE_KEY);
  render();
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
});

$("#tournament-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const maxRounds = Number(form.elements.rounds.value);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 30) {
    showToast("Počet kol musí být celé číslo od 1 do 30.");
    return;
  }
  if (tournament && tournament.rounds.length && maxRounds < tournament.rounds.length) {
    showToast("Počet kol nemůže být nižší než počet již odehraných kol.");
    return;
  }
  if (!tournament) {
    tournament = { id: createId(), players: [], rounds: [], nextByeId: null };
    selectedRound = 0;
  }
  tournament.name = form.elements.name.value.trim();
  tournament.organizer = form.elements.organizer.value.trim();
  tournament.location = form.elements.location.value.trim();
  tournament.date = form.elements.date.value;
  tournament.maxRounds = maxRounds;
  saveTournament();
  $("#tournament-dialog").close();
  render();
});

$("#tournament-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

render();
