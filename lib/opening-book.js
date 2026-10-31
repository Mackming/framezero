/**
 * opening-book.js — a small, hand-curated table of well-known opening lines.
 *
 * Pure data + pure lookup logic, no extension or DOM APIs, so it is
 * unit-tested directly (test/opening-book.test.js).
 *
 * Moves are UCI ("e2e4"), not SAN — SAN would need every entry to exactly
 * match chess.js's own check/mate suffix ('+'/'#') on every move, which is
 * an easy, silent way to get an entry subtly wrong. UCI is unambiguous pure
 * geometry (fromSquare+toSquare[+promotion]) and is already this codebase's
 * lingua franca (it's what Stockfish speaks and what every other UCI-move
 * comparison in this project already uses).
 *
 * This is a genuinely small slice of chess theory, not a database: enough to
 * recognize the openings a casual game (especially against a low-level
 * Stockfish opponent, which tends to play natural, book-ish moves) actually
 * reaches, not exhaustive tournament-prep-depth coverage. It degrades
 * gracefully — anything not in here just falls through to the engine, same
 * as always.
 */

export const OPENING_BOOK = [
  // --- 1.e4 e5 ------------------------------------------------------------
  { eco: 'C50', name: 'Italian Game', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'] },
  { eco: 'C50', name: 'Italian Game: Giuoco Pianissimo', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3'] },
  { eco: 'C53', name: 'Italian Game: Giuoco Piano', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3'] },
  { eco: 'C54', name: 'Italian Game: Classical Variation', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d4'] },
  { eco: 'C55', name: 'Two Knights Defense', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'] },
  { eco: 'C57', name: 'Two Knights Defense: Fried Liver Attack', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'f6d5', 'g5f7'] },
  { eco: 'C56', name: "Two Knights Defense: Traxler Counterattack", moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'f8c5'] },
  { eco: 'C60', name: 'Ruy Lopez', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'] },
  { eco: 'C65', name: 'Ruy Lopez: Berlin Defense', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'g8f6'] },
  { eco: 'C67', name: 'Ruy Lopez: Berlin Defense, Rio Gambit Accepted', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'g8f6', 'e1g1', 'f6e4'] },
  { eco: 'C68', name: 'Ruy Lopez: Exchange Variation', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5c6', 'd7c6'] },
  { eco: 'C70', name: 'Ruy Lopez: Morphy Defense', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4'] },
  { eco: 'C77', name: 'Ruy Lopez: Morphy Defense, Anderssen Variation', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6'] },
  { eco: 'C84', name: 'Ruy Lopez: Closed, Main Line', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'd7d6', 'c2c3', 'e8g8'] },
  { eco: 'C88', name: 'Ruy Lopez: Closed, Anti-Marshall', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'e8g8', 'a2a4'] },
  { eco: 'C89', name: 'Ruy Lopez: Marshall Attack', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'e8g8', 'c2c3', 'd7d5'] },
  { eco: 'C44', name: 'Scotch Game', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4'] },
  { eco: 'C45', name: 'Scotch Game: Main Line', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f3d4', 'g8f6'] },
  { eco: 'C42', name: "Petrov's Defense", moves: ['e2e4', 'e7e5', 'g1f3', 'g8f6'] },
  { eco: 'C43', name: "Petrov's Defense: Steinitz Attack", moves: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'd2d4'] },
  { eco: 'C47', name: 'Four Knights Game', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6'] },
  { eco: 'C48', name: 'Four Knights Game: Spanish Variation', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'f1b5'] },
  { eco: 'C46', name: 'Three Knights Game', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3'] },
  { eco: 'C25', name: 'Vienna Game', moves: ['e2e4', 'e7e5', 'b1c3'] },
  { eco: 'C29', name: 'Vienna Game: Vienna Gambit', moves: ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f2f4'] },
  { eco: 'C30', name: "King's Gambit", moves: ['e2e4', 'e7e5', 'f2f4'] },
  { eco: 'C33', name: "King's Gambit Accepted", moves: ['e2e4', 'e7e5', 'f2f4', 'e5f4'] },
  { eco: 'C30', name: "King's Gambit Declined: Classical Variation", moves: ['e2e4', 'e7e5', 'f2f4', 'f8c5'] },
  { eco: 'C41', name: 'Philidor Defense', moves: ['e2e4', 'e7e5', 'g1f3', 'd7d6'] },
  { eco: 'C21', name: 'Danish Gambit', moves: ['e2e4', 'e7e5', 'd2d4', 'e5d4', 'c2c3'] },
  { eco: 'C23', name: "Bishop's Opening", moves: ['e2e4', 'e7e5', 'f1c4'] },

  // --- 1.e4 c5 (Sicilian) --------------------------------------------------
  { eco: 'B20', name: 'Sicilian Defense', moves: ['e2e4', 'c7c5'] },
  { eco: 'B27', name: 'Sicilian Defense: Open', moves: ['e2e4', 'c7c5', 'g1f3'] },
  { eco: 'B32', name: 'Sicilian Defense: Open, Main Line', moves: ['e2e4', 'c7c5', 'g1f3', 'b8c6', 'd2d4', 'c5d4', 'f3d4'] },
  { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'] },
  { eco: 'B96', name: 'Sicilian Defense: Najdorf, Polugaevsky Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6', 'c1g5', 'e7e6', 'f2f4', 'b7b5'] },
  { eco: 'B70', name: 'Sicilian Defense: Dragon Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'g7g6'] },
  { eco: 'B76', name: 'Sicilian Defense: Dragon, Yugoslav Attack', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'g7g6', 'c1e3', 'f8g7', 'f2f3'] },
  { eco: 'B56', name: 'Sicilian Defense: Classical Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'b8c6'] },
  { eco: 'B60', name: 'Sicilian Defense: Richter-Rauzer', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'b8c6', 'c1g5'] },
  { eco: 'B40', name: 'Sicilian Defense: Scheveningen-type', moves: ['e2e4', 'c7c5', 'g1f3', 'e7e6'] },
  { eco: 'B80', name: 'Sicilian Defense: Scheveningen Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'e7e6'] },
  { eco: 'B33', name: 'Sicilian Defense: Sveshnikov Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'b8c6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'e7e5'] },
  { eco: 'B30', name: 'Sicilian Defense: Rossolimo Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'b8c6', 'f1b5'] },
  { eco: 'B23', name: 'Sicilian Defense: Closed', moves: ['e2e4', 'c7c5', 'b1c3'] },
  { eco: 'B22', name: 'Sicilian Defense: Alapin Variation', moves: ['e2e4', 'c7c5', 'c2c3'] },
  { eco: 'B21', name: 'Sicilian Defense: Smith-Morra Gambit', moves: ['e2e4', 'c7c5', 'd2d4', 'c5d4', 'c2c3'] },
  { eco: 'B50', name: 'Sicilian Defense: Kan-type', moves: ['e2e4', 'c7c5', 'g1f3', 'e7e6', 'd2d4', 'c5d4', 'f3d4', 'a7a6'] },
  { eco: 'B44', name: 'Sicilian Defense: Taimanov Variation', moves: ['e2e4', 'c7c5', 'g1f3', 'b8c6', 'd2d4', 'c5d4', 'f3d4', 'e7e6'] },

  // --- 1.e4 e6 (French) -----------------------------------------------------
  { eco: 'C00', name: 'French Defense', moves: ['e2e4', 'e7e6'] },
  { eco: 'C02', name: 'French Defense: Advance Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4e5'] },
  { eco: 'C01', name: 'French Defense: Exchange Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4d5', 'e6d5'] },
  { eco: 'C03', name: 'French Defense: Tarrasch Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1d2'] },
  { eco: 'C10', name: 'French Defense: Rubinstein Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'] },
  { eco: 'C11', name: 'French Defense: Classical Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'g8f6'] },
  { eco: 'C15', name: 'French Defense: Winawer Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'f8b4'] },
  { eco: 'C13', name: 'French Defense: Classical, Steinitz Variation', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'g8f6', 'c1g5', 'f8e7', 'e4e5'] },

  // --- 1.e4 c6 (Caro-Kann) --------------------------------------------------
  { eco: 'B10', name: 'Caro-Kann Defense', moves: ['e2e4', 'c7c6'] },
  { eco: 'B12', name: 'Caro-Kann Defense: Advance Variation', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5'] },
  { eco: 'B13', name: 'Caro-Kann Defense: Exchange Variation', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5'] },
  { eco: 'B14', name: 'Caro-Kann Defense: Panov-Botvinnik Attack', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5', 'c2c4'] },
  { eco: 'B18', name: 'Caro-Kann Defense: Classical Variation', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'c8f5'] },
  { eco: 'B17', name: 'Caro-Kann Defense: Steinitz Variation', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'b8d7'] },
  { eco: 'B15', name: 'Caro-Kann Defense: Main Line', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3'] },

  // --- other 1.e4 replies ----------------------------------------------------
  { eco: 'B01', name: 'Scandinavian Defense', moves: ['e2e4', 'd7d5'] },
  { eco: 'B01', name: 'Scandinavian Defense: Main Line', moves: ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5a5'] },
  { eco: 'B07', name: 'Pirc Defense', moves: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6'] },
  { eco: 'B09', name: 'Pirc Defense: Austrian Attack', moves: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'f2f4'] },
  { eco: 'B06', name: 'Modern Defense', moves: ['e2e4', 'g7g6'] },
  { eco: 'B02', name: "Alekhine's Defense", moves: ['e2e4', 'g8f6'] },
  { eco: 'B03', name: "Alekhine's Defense: Main Line", moves: ['e2e4', 'g8f6', 'e4e5', 'f6d5', 'd2d4', 'd7d6'] },
  { eco: 'A00', name: "Nimzowitsch Defense", moves: ['e2e4', 'b8c6'] },

  // --- 1.d4 d5 (Queen's Pawn) ------------------------------------------------
  { eco: 'D06', name: "Queen's Gambit", moves: ['d2d4', 'd7d5', 'c2c4'] },
  { eco: 'D20', name: "Queen's Gambit Accepted", moves: ['d2d4', 'd7d5', 'c2c4', 'd5c4'] },
  { eco: 'D30', name: "Queen's Gambit Declined", moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6'] },
  { eco: 'D31', name: "Queen's Gambit Declined: Main Line", moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3'] },
  { eco: 'D37', name: "Queen's Gambit Declined: Classical Variation", moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'g1f3', 'f8e7'] },
  { eco: 'D35', name: "Queen's Gambit Declined: Exchange Variation", moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'c4d5', 'e6d5'] },
  { eco: 'D10', name: 'Slav Defense', moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6'] },
  { eco: 'D15', name: 'Slav Defense: Main Line', moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3'] },
  { eco: 'D43', name: 'Semi-Slav Defense', moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'e7e6'] },
  { eco: 'D46', name: 'Semi-Slav Defense: Meran Variation', moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'e7e6', 'e2e3', 'b8d7', 'f1d3', 'd5c4', 'd3c4', 'b7b5'] },
  { eco: 'D02', name: 'London System', moves: ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'c1f4'] },
  { eco: 'D05', name: 'Colle System', moves: ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'e2e3'] },
  { eco: 'A45', name: 'Trompowsky Attack', moves: ['d2d4', 'g8f6', 'c1g5'] },
  { eco: 'D00', name: "Blackmar-Diemer Gambit", moves: ['d2d4', 'd7d5', 'e2e4'] },

  // --- 1.d4 Nf6 (Indian systems) ----------------------------------------------
  { eco: 'A45', name: 'Indian Defense', moves: ['d2d4', 'g8f6'] },
  { eco: 'E20', name: 'Nimzo-Indian Defense', moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4'] },
  { eco: 'E32', name: 'Nimzo-Indian Defense: Classical Variation', moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'd1c2'] },
  { eco: 'E24', name: 'Nimzo-Indian Defense: Sämisch Variation', moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'a2a3', 'b4c3', 'b2c3'] },
  { eco: 'E12', name: "Queen's Indian Defense", moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g1f3', 'b7b6'] },
  { eco: 'E00', name: 'Catalan Opening', moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g2g3'] },
  { eco: 'E60', name: "King's Indian Defense", moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6'] },
  { eco: 'E61', name: "King's Indian Defense: Main Line", moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6'] },
  { eco: 'E69', name: "King's Indian Defense: Classical, Main Line", moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'g1f3', 'e8g8', 'f1e2', 'e7e5', 'e1g1', 'b8c6', 'd4d5'] },
  { eco: 'E76', name: "King's Indian Defense: Four Pawns Attack", moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'f2f4'] },
  { eco: 'D70', name: 'Grünfeld Defense', moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5'] },
  { eco: 'D85', name: 'Grünfeld Defense: Exchange Variation', moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5', 'c4d5', 'f6d5', 'e2e4', 'd5c3', 'b2c3'] },
  { eco: 'A56', name: 'Benoni Defense', moves: ['d2d4', 'g8f6', 'c2c4', 'c7c5'] },
  { eco: 'A60', name: 'Modern Benoni', moves: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'e7e6'] },
  { eco: 'A80', name: 'Dutch Defense', moves: ['d2d4', 'f7f5'] },
  { eco: 'A90', name: 'Dutch Defense: Stonewall Variation', moves: ['d2d4', 'f7f5', 'g2g3', 'g8f6', 'f1g2', 'e7e6', 'g1f3', 'd7d5'] },
  { eco: 'A40', name: "Queen's Pawn Game", moves: ['d2d4', 'e7e6'] },

  // --- flank openings ---------------------------------------------------------
  { eco: 'A10', name: 'English Opening', moves: ['c2c4'] },
  { eco: 'A20', name: 'English Opening: Reversed Sicilian', moves: ['c2c4', 'e7e5'] },
  { eco: 'A30', name: 'English Opening: Symmetrical Variation', moves: ['c2c4', 'c7c5'] },
  { eco: 'A15', name: 'English Opening: Anglo-Indian Defense', moves: ['c2c4', 'g8f6'] },
  { eco: 'A09', name: 'Réti Opening', moves: ['g1f3', 'd7d5', 'c2c4'] },
  { eco: 'A05', name: "Réti Opening: King's Indian Attack-type", moves: ['g1f3', 'g8f6'] },
  { eco: 'A04', name: 'Réti Opening', moves: ['g1f3'] },
  { eco: 'A02', name: "Bird's Opening", moves: ['f2f4'] },
  { eco: 'A00', name: 'Van Geet Opening', moves: ['b1c3'] },
  { eco: 'A00', name: "King's Fianchetto Opening", moves: ['g2g3'] }
];

/**
 * A second book, for the sharp playing styles. Same shape as OPENING_BOOK,
 * different taste: every line here deliberately gives up material for time,
 * space or an attack, so the first ten moves of an `aggro` or `trap` game
 * already look nothing like the mainline book above.
 *
 * Both colours are covered — a gambit book that only knew what to do as
 * White would silently fall through to the engine every time the bot was
 * Black, which is exactly when the style is most visible.
 */
export const GAMBIT_BOOK = [
  // --- King's Gambit ------------------------------------------------------
  { eco: 'C30', name: "King's Gambit", moves: ['e2e4', 'e7e5', 'f2f4'] },
  { eco: 'C33', name: "King's Gambit Accepted", moves: ['e2e4', 'e7e5', 'f2f4', 'e5f4'] },
  { eco: 'C33', name: "King's Gambit: Bishop's Gambit", moves: ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'f1c4'] },
  { eco: 'C34', name: "King's Gambit Accepted: Fischer Defense", moves: ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'g1f3', 'd7d6'] },
  { eco: 'C39', name: "King's Gambit: Kieseritzky Gambit", moves: ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'g1f3', 'g7g5', 'h2h4', 'g5g4', 'f3e5'] },
  { eco: 'C37', name: "King's Gambit: Muzio Gambit", moves: ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'g1f3', 'g7g5', 'f1c4', 'g5g4', 'e1g1'] },
  { eco: 'C36', name: "King's Gambit Declined: Falkbeer Countergambit", moves: ['e2e4', 'e7e5', 'f2f4', 'd7d5'] },

  // --- 1.e4 e5, other sacrifices ------------------------------------------
  { eco: 'C21', name: 'Danish Gambit', moves: ['e2e4', 'e7e5', 'd2d4', 'e5d4', 'c2c3'] },
  { eco: 'C21', name: 'Danish Gambit Accepted', moves: ['e2e4', 'e7e5', 'd2d4', 'e5d4', 'c2c3', 'd4c3', 'f1c4', 'c3b2', 'c1b2'] },
  { eco: 'C44', name: 'Scotch Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f1c4'] },
  { eco: 'C44', name: 'Goering Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'c2c3'] },
  { eco: 'C51', name: 'Evans Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'b2b4'] },
  { eco: 'C52', name: 'Evans Gambit Accepted', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'b2b4', 'c5b4', 'c2c3'] },
  { eco: 'C57', name: 'Two Knights: Fried Liver Attack', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'f6d5', 'g5f7'] },
  { eco: 'C25', name: 'Vienna Gambit', moves: ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f2f4'] },
  { eco: 'C46', name: 'Halloween Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'f3e5'] },
  { eco: 'C42', name: 'Petrov: Cochrane Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3e5', 'd7d6', 'e5f7'] },

  // --- Black gambits against 1.e4 -----------------------------------------
  { eco: 'C40', name: 'Latvian Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'f7f5'] },
  { eco: 'C40', name: 'Elephant Gambit', moves: ['e2e4', 'e7e5', 'g1f3', 'd7d5'] },
  { eco: 'C57', name: 'Two Knights: Traxler Counterattack', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'f8c5'] },
  { eco: 'B21', name: 'Sicilian: Smith-Morra Gambit', moves: ['e2e4', 'c7c5', 'd2d4', 'c5d4', 'c2c3'] },
  { eco: 'B21', name: 'Sicilian: Smith-Morra Gambit Accepted', moves: ['e2e4', 'c7c5', 'd2d4', 'c5d4', 'c2c3', 'd4c3', 'b1c3'] },
  { eco: 'B01', name: 'Scandinavian: Icelandic Gambit', moves: ['e2e4', 'd7d5', 'e4d5', 'g8f6'] },

  // --- 1.d4 complexes -----------------------------------------------------
  { eco: 'D00', name: 'Blackmar-Diemer Gambit', moves: ['d2d4', 'd7d5', 'e2e4', 'd5e4', 'b1c3'] },
  { eco: 'D00', name: 'Blackmar-Diemer Gambit Accepted', moves: ['d2d4', 'd7d5', 'e2e4', 'd5e4', 'b1c3', 'g8f6', 'f2f3'] },
  { eco: 'A40', name: 'Englund Gambit', moves: ['d2d4', 'e7e5'] },
  { eco: 'A40', name: 'Englund Gambit Accepted', moves: ['d2d4', 'e7e5', 'd4e5', 'b8c6'] },
  { eco: 'A51', name: 'Budapest Gambit', moves: ['d2d4', 'g8f6', 'c2c4', 'e7e5'] },
  { eco: 'A52', name: 'Budapest Gambit Accepted', moves: ['d2d4', 'g8f6', 'c2c4', 'e7e5', 'd4e5', 'f6g4'] },
  { eco: 'A57', name: 'Benko Gambit', moves: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'b7b5'] },
  { eco: 'D08', name: 'Albin Countergambit', moves: ['d2d4', 'd7d5', 'c2c4', 'e7e5'] },

  // --- odds and ends ------------------------------------------------------
  { eco: 'A02', name: "From's Gambit", moves: ['f2f4', 'e7e5'] }
];

/** The books, by the `book` name a move-policy mode declares. */
export const BOOKS = { main: OPENING_BOOK, gambit: GAMBIT_BOOK };

/** Resolve a book name, falling back to the mainline book. */
export function getBook(name) {
  return BOOKS[name] ?? OPENING_BOOK;
}

/** Longest book move-list matching a given predicate on its own length, exact-prefix-matched against history. */
function longestPrefixMatch(uciHistory, predicate, book) {
  let best = null;
  for (const entry of book) {
    if (!predicate(entry.moves.length)) continue;
    let matches = true;
    const checkLen = Math.min(entry.moves.length, uciHistory.length);
    for (let i = 0; i < checkLen; i++) {
      if (entry.moves[i] !== uciHistory[i]) { matches = false; break; }
    }
    if (matches && (!best || entry.moves.length > best.moves.length)) best = entry;
  }
  return best;
}

/**
 * @param {string[]} uciHistory  Moves played so far, in UCI ("e2e4"), in order.
 * @param {object}   [opts]
 * @param {Array}    [opts.book]    Which book to consult; defaults to the
 *   mainline one. See BOOKS / getBook() for the alternatives.
 * @param {Function} [opts.random]  When supplied, the next move is drawn at
 *   random with each candidate weighted by its vote count, instead of the
 *   highest-voted move always winning. Plain majority vote is deterministic,
 *   which means the same opening every single game — fine for a book meant
 *   to play mainlines, dull for one meant to supply variety. Injectable so
 *   the choice stays testable.
 * @returns {{ name: string|null, eco: string|null, bookMove: string|null }}
 *   `name`/`eco` describe the deepest known opening reached by this exact
 *   history (from an entry fully contained within it); `bookMove` is the
 *   next move to play if at least one entry continues past the current
 *   position in agreement with what's been played.
 */
export function lookupOpening(uciHistory, { book = OPENING_BOOK, random = null } = {}) {
  const named = longestPrefixMatch(uciHistory, (len) => len <= uciHistory.length, book);

  const votes = new Map();
  for (const entry of book) {
    if (entry.moves.length <= uciHistory.length) continue;
    let matches = true;
    for (let i = 0; i < uciHistory.length; i++) {
      if (entry.moves[i] !== uciHistory[i]) { matches = false; break; }
    }
    if (!matches) continue;
    const next = entry.moves[uciHistory.length];
    votes.set(next, (votes.get(next) ?? 0) + 1);
  }

  let bookMove = null;
  if (votes.size && typeof random === 'function') {
    // Weighted draw: a move backed by four book lines is four times as likely
    // as one backed by a single line, so variety never costs soundness.
    let roll = random() * [...votes.values()].reduce((sum, n) => sum + n, 0);
    for (const [move, count] of votes) {
      bookMove = move;               // also the fallback if rounding eats the roll
      roll -= count;
      if (roll < 0) break;
    }
  } else {
    let bestVotes = 0;
    for (const [move, count] of votes) {
      if (count > bestVotes) { bookMove = move; bestVotes = count; }
    }
  }

  return {
    name: named?.name ?? null,
    eco: named?.eco ?? null,
    bookMove
  };
}
