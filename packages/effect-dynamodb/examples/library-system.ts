/**
 * Library System Example — Multi-Entity Single-Table Design with 3 GSIs
 *
 * Adapted from the ElectroDB Library System example:
 * https://electrodb.dev/en/examples/library-system/
 *
 * Demonstrates advanced effect-dynamodb patterns:
 * - 4 entities (Author, Book, Genre, Member) in one table
 * - 3 GSIs with index overloading
 * - 4 cross-entity collection patterns via shared GSI indexes
 * - Sparse index pattern (Book loans GSI only populated when loaned)
 * - 8 access patterns with strong assertions
 *
 * Table design:
 *   Primary: pk/sk
 *   GSI1: gsi1pk/gsi1sk — loans (Book), account (Member+Book)
 *   GSI2: gsi2pk/gsi2sk — works (Author+Book+Genre)
 *   GSI3: gsi3pk/gsi3sk — titles (Book+Genre)
 *
 * Collections:
 *   works:   Author + Book + Genre by author name (gsi2)
 *   account: Member + Book by memberId           (gsi1)
 *   titles:  Book + Genre by bookTitle            (gsi3)
 *   categories: Genre by genre                    (gsi1, isolated)
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/library-system.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

// #region models
class Author extends Schema.Class<Author>("Author")({
  authorFirstName: Schema.String,
  authorLastName: Schema.String,
  birthday: Schema.String,
  bio: Schema.String,
}) {}

class Book extends Schema.Class<Book>("Book")({
  bookId: Schema.String,
  bookTitle: Schema.String,
  description: Schema.String,
  publisher: Schema.String,
  releaseDate: Schema.String,
  authorFirstName: Schema.String,
  authorLastName: Schema.String,
  isbn: Schema.String,
  memberId: Schema.optional(Schema.String),
  loanEndDate: Schema.optional(Schema.String),
}) {}

class Genre extends Schema.Class<Genre>("Genre")({
  genre: Schema.String,
  subgenre: Schema.String,
  isbn: Schema.String,
  bookTitle: Schema.String,
  authorFirstName: Schema.String,
  authorLastName: Schema.String,
}) {}

class Member extends Schema.Class<Member>("Member")({
  memberId: Schema.String,
  membershipStartDate: Schema.String,
  membershipEndDate: Schema.String,
  city: Schema.String,
  state: Schema.String,
}) {}
// #endregion

// =============================================================================
// 2. Schema
// =============================================================================

// #region schema
const LibSchema = DynamoSchema.make({ name: "library", version: 1 })
// #endregion

// =============================================================================
// 3. Entity definitions — primary key only
// =============================================================================

/**
 * Author — primary key only
 *
 * Primary: identity key by last name + first name
 */
// #region author-entity
const Authors = Entity.make({
  model: Author,
  entityType: "Author",
  primaryKey: {
    pk: { field: "pk", composite: ["authorLastName"] },
    sk: { field: "sk", composite: ["authorFirstName"] },
  },
  indexes: {
    works: {
      collection: "works",
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["authorLastName", "authorFirstName"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  timestamps: true,
})
// #endregion

/**
 * Book — primary key only
 *
 * Primary: copies by isbn + bookId
 */
// #region book-entity
const Books = Entity.make({
  model: Book,
  entityType: "Book",
  primaryKey: {
    pk: { field: "pk", composite: ["isbn"] },
    sk: { field: "sk", composite: ["bookId"] },
  },
  indexes: {
    account: {
      collection: "account",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["memberId"] },
      sk: { field: "gsi1sk", composite: ["loanEndDate"] },
    },
    works: {
      collection: "works",
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["authorLastName", "authorFirstName"] },
      sk: { field: "gsi2sk", composite: ["bookId"] },
    },
    titles: {
      collection: "titles",
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["bookTitle"] },
      sk: { field: "gsi3sk", composite: ["releaseDate"] },
    },
  },
  timestamps: true,
})
// #endregion

/**
 * Genre — primary key only
 *
 * Primary: genres by isbn + genre + subgenre
 */
// #region genre-entity
const Genres = Entity.make({
  model: Genre,
  entityType: "Genre",
  primaryKey: {
    pk: { field: "pk", composite: ["isbn"] },
    sk: { field: "sk", composite: ["genre", "subgenre"] },
  },
  indexes: {
    byGenre: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["genre"] },
      sk: { field: "gsi1sk", composite: ["subgenre"] },
    },
    works: {
      collection: "works",
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["authorLastName", "authorFirstName"] },
      sk: { field: "gsi2sk", composite: ["genre"] },
    },
    titles: {
      collection: "titles",
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["bookTitle"] },
      sk: { field: "gsi3sk", composite: ["genre", "subgenre"] },
    },
  },
  timestamps: true,
})
// #endregion

/**
 * Member — primary key only
 *
 * Primary: identity key by memberId
 */
// #region member-entity
const Members = Entity.make({
  model: Member,
  entityType: "Member",
  primaryKey: {
    pk: { field: "pk", composite: ["memberId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    account: {
      collection: "account",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["memberId"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
  timestamps: true,
})
// #endregion

// =============================================================================
// 4. Table + Collections — GSI access patterns
// =============================================================================

// #region table
const LibTable = Table.make({ schema: LibSchema, entities: { Authors, Books, Genres, Members } })
// #endregion

// #region collections
// GSI access patterns are now defined as entity-level indexes above.
// Multi-entity collections (account, works, titles) are auto-discovered
// from matching collection names across entities.
// #endregion

// =============================================================================
// 5. Seed data
// =============================================================================

// #region seed-data
const authors = {
  tolkien: {
    authorFirstName: "J.R.R.",
    authorLastName: "Tolkien",
    birthday: "1892-01-03",
    bio: "English writer and philologist, best known for The Hobbit and The Lord of the Rings",
  },
  asimov: {
    authorFirstName: "Isaac",
    authorLastName: "Asimov",
    birthday: "1920-01-02",
    bio: "American author and biochemist, prolific writer of science fiction and popular science",
  },
} as const

const books = {
  hobbit: {
    bookId: "b-hobbit",
    bookTitle: "The Hobbit",
    description: "A fantasy novel about the adventures of Bilbo Baggins",
    publisher: "George Allen & Unwin",
    releaseDate: "1937-09-21",
    authorFirstName: "J.R.R.",
    authorLastName: "Tolkien",
    isbn: "978-0-547-928227",
  },
  foundation: {
    bookId: "b-foundation",
    bookTitle: "Foundation",
    description: "A science fiction novel about the fall of a galactic empire",
    publisher: "Gnome Press",
    releaseDate: "1951-06-01",
    authorFirstName: "Isaac",
    authorLastName: "Asimov",
    isbn: "978-0-553-293357",
  },
  iRobot: {
    bookId: "b-irobot",
    bookTitle: "I, Robot",
    description: "A collection of nine science fiction short stories about robots",
    publisher: "Gnome Press",
    releaseDate: "1950-12-02",
    authorFirstName: "Isaac",
    authorLastName: "Asimov",
    isbn: "978-0-553-294385",
  },
} as const

const genres = {
  hobbitFantasy: {
    genre: "Fantasy",
    subgenre: "High Fantasy",
    isbn: "978-0-547-928227",
    bookTitle: "The Hobbit",
    authorFirstName: "J.R.R.",
    authorLastName: "Tolkien",
  },
  foundationSciFi: {
    genre: "Sci-Fi",
    subgenre: "Space Opera",
    isbn: "978-0-553-293357",
    bookTitle: "Foundation",
    authorFirstName: "Isaac",
    authorLastName: "Asimov",
  },
  iRobotSciFi: {
    genre: "Sci-Fi",
    subgenre: "Robotics",
    isbn: "978-0-553-294385",
    bookTitle: "I, Robot",
    authorFirstName: "Isaac",
    authorLastName: "Asimov",
  },
} as const

const members = {
  alice: {
    memberId: "m-alice",
    membershipStartDate: "2023-01-15",
    membershipEndDate: "2026-01-15",
    city: "New York",
    state: "NY",
  },
  bob: {
    memberId: "m-bob",
    membershipStartDate: "2024-03-01",
    membershipEndDate: "2027-03-01",
    city: "Los Angeles",
    state: "CA",
  },
} as const
// #endregion

// =============================================================================
// 6. Helpers
// =============================================================================

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 7. Main program — 8 access patterns with assertions
// =============================================================================

const program = Effect.gen(function* () {
  // #region seed-insert
  // Typed execution gateway — binds all entities and collections
  const db = yield* DynamoClient.make({
    entities: { Authors, Books, Genres, Members },
  })

  // --- Setup: create table ---
  yield* db.tables["library-table"]!.create()

  // --- Seed data ---
  for (const author of Object.values(authors)) {
    yield* db.entities.Authors.put(author)
  }
  for (const book of Object.values(books)) {
    yield* db.entities.Books.put(book)
  }
  for (const g of Object.values(genres)) {
    yield* db.entities.Genres.put(g)
  }
  for (const member of Object.values(members)) {
    yield* db.entities.Members.put(member)
  }
  // #endregion

  // -------------------------------------------------------------------------
  // Pattern 1: Get author by name (primary key)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 1: Get Author by Name (primary)")

  // #region get-author
  const tolkien = yield* db.entities.Authors.get({
    authorLastName: "Tolkien",
    authorFirstName: "J.R.R.",
  })
  // tolkien.birthday → "1892-01-03"
  // tolkien.bio → "English writer and philologist..."

  const asimov = yield* db.entities.Authors.get({
    authorLastName: "Asimov",
    authorFirstName: "Isaac",
  })
  // asimov.birthday → "1920-01-02"
  // #endregion
  assertEq(tolkien.authorFirstName, "J.R.R.", "tolkien firstName")
  assertEq(tolkien.authorLastName, "Tolkien", "tolkien lastName")
  assertEq(tolkien.birthday, "1892-01-03", "tolkien birthday")
  assert(tolkien.bio.includes("philologist"), "tolkien bio")
  assertEq(asimov.authorFirstName, "Isaac", "asimov firstName")
  assertEq(asimov.birthday, "1920-01-02", "asimov birthday")
  yield* Console.log("  Get authors: Tolkien + Asimov — OK")

  // -------------------------------------------------------------------------
  // Pattern 2: Get book copies by ISBN (primary key) — "detail" concept
  //
  // Book and Genre share the same primary PK (isbn). Querying by isbn
  // on each entity retrieves related items. This is the "detail" pattern.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 2: Book + Genre by ISBN (primary — detail)")

  // #region detail-by-isbn
  // Get the book
  const hobbit = yield* db.entities.Books.get({
    isbn: "978-0-547-928227",
    bookId: "b-hobbit",
  })
  // hobbit.bookTitle → "The Hobbit"
  // hobbit.publisher → "George Allen & Unwin"

  // Get the genre for the same ISBN
  const hobbitGenre = yield* db.entities.Genres.get({
    isbn: "978-0-547-928227",
    genre: "Fantasy",
    subgenre: "High Fantasy",
  })
  // hobbitGenre.genre → "Fantasy"
  // hobbitGenre.subgenre → "High Fantasy"
  // #endregion
  assertEq(hobbit.bookTitle, "The Hobbit", "hobbit title")
  assertEq(hobbit.authorLastName, "Tolkien", "hobbit author")
  assertEq(hobbit.releaseDate, "1937-09-21", "hobbit releaseDate")
  assertEq(hobbit.publisher, "George Allen & Unwin", "hobbit publisher")
  assertEq(hobbitGenre.genre, "Fantasy", "hobbit genre")
  assertEq(hobbitGenre.subgenre, "High Fantasy", "hobbit subgenre")
  assertEq(hobbitGenre.bookTitle, "The Hobbit", "hobbit genre bookTitle")
  yield* Console.log("  Detail: Book + Genre by ISBN — OK")

  // -------------------------------------------------------------------------
  // Pattern 3: Author's works — books + genres by author (gsi2 "works")
  //
  // The "works" collection on gsi2 groups Author, Book, and Genre by
  // authorLastName + authorFirstName. Query the collection to retrieve
  // all of an author's associated items.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 3: Author's Works (gsi2 — works collection)")

  // #region works-collection
  // Asimov's books
  const { Books: asimovBooks } = yield* db.collections.works!({
    authorLastName: "Asimov",
    authorFirstName: "Isaac",
  }).collect()
  // → [{ bookTitle: "Foundation", ... }, { bookTitle: "I, Robot", ... }]

  // Asimov's genres
  const { Genres: asimovGenres } = yield* db.collections.works!({
    authorLastName: "Asimov",
    authorFirstName: "Isaac",
  }).collect()
  // → [{ subgenre: "Space Opera", ... }, { subgenre: "Robotics", ... }]

  // Author's own record in the works collection
  const { Authors: tolkienInfo } = yield* db.collections.works!({
    authorLastName: "Tolkien",
    authorFirstName: "J.R.R.",
  }).collect()
  // → [{ birthday: "1892-01-03", bio: "...", ... }]
  // #endregion
  assertEq(asimovBooks.length, 2, "Asimov has 2 books")
  const asimovTitles = asimovBooks.map((b: any) => b.bookTitle).sort()
  assertEq(asimovTitles, ["Foundation", "I, Robot"], "Asimov book titles")
  assertEq(asimovGenres.length, 2, "Asimov has 2 genres")
  const asimovSubgenres = asimovGenres.map((g: any) => g.subgenre).sort()
  assertEq(asimovSubgenres, ["Robotics", "Space Opera"], "Asimov subgenres")

  const { Books: tolkienBooks } = yield* db.collections.works!({
    authorLastName: "Tolkien",
    authorFirstName: "J.R.R.",
  }).collect()
  assertEq(tolkienBooks.length, 1, "Tolkien has 1 book")
  assertEq(tolkienBooks[0]!.bookTitle, "The Hobbit", "Tolkien book title")
  assertEq(tolkienInfo.length, 1, "Tolkien has 1 author record in works")
  assertEq(tolkienInfo[0]!.birthday, "1892-01-03", "Tolkien birthday from works")
  yield* Console.log("  Works: Author + Books + Genres by author — OK")

  // -------------------------------------------------------------------------
  // Pattern 4: Member account — member info + loaned books (gsi1 "account")
  //
  // Before any loans, the account collection returns only the member.
  // After loaning a book, the loaned book appears in the collection too.
  // Both share gsi1 via the "account" collection.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 4: Member Account (gsi1 — account collection)")

  // #region account-collection
  // Member profile
  const { Members: aliceAccount } = yield* db.collections.account!({
    memberId: "m-alice",
  }).collect()
  // → [{ memberId: "m-alice", city: "New York", state: "NY", ... }]

  // Alice's loaned books (initially empty -- sparse index)
  const { Books: aliceLoans } = yield* db.collections.account!({ memberId: "m-alice" }).collect()
  // → [] (no books loaned yet)
  // #endregion
  assertEq(aliceAccount.length, 1, "Alice has 1 account record (no loans yet)")
  assertEq(aliceAccount[0]!.city, "New York", "Alice city")
  assertEq(aliceAccount[0]!.state, "NY", "Alice state")
  assertEq(aliceLoans.length, 0, "Alice has 0 loaned books initially")
  yield* Console.log("  Account: Member info (no loans yet) — OK")

  // -------------------------------------------------------------------------
  // Pattern 5: Books by title (gsi3 "titles" collection)
  //
  // Book and Genre share gsi3 with PK=bookTitle. Query the collection
  // to find items by title.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 5: Books by Title (gsi3 — titles collection)")

  // #region titles-collection
  const { Books: foundationByTitle } = yield* db.collections.titles!({
    bookTitle: "Foundation",
  }).collect()
  // → [{ isbn: "978-0-553-293357", releaseDate: "1951-06-01", ... }]

  const { Genres: foundationGenresByTitle } = yield* db.collections.titles!({
    bookTitle: "Foundation",
  }).collect()
  // → [{ genre: "Sci-Fi", subgenre: "Space Opera", ... }]
  // #endregion
  assertEq(foundationByTitle.length, 1, "1 book titled Foundation")
  assertEq(foundationByTitle[0]!.isbn, "978-0-553-293357", "Foundation ISBN")
  assertEq(foundationByTitle[0]!.releaseDate, "1951-06-01", "Foundation release")
  assertEq(foundationGenresByTitle.length, 1, "Foundation has 1 genre")
  assertEq(foundationGenresByTitle[0]!.genre, "Sci-Fi", "Foundation genre")
  assertEq(foundationGenresByTitle[0]!.subgenre, "Space Opera", "Foundation subgenre")
  yield* Console.log("  Titles: Book + Genre by title — OK")

  // -------------------------------------------------------------------------
  // Pattern 6: Genre categories (gsi1 on Genre — standalone)
  //
  // Browse genres by category. This is a standalone GSI on Genre,
  // not part of a collection.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 6: Genre Categories (gsi1 — standalone)")

  // #region genre-categories
  // All Sci-Fi subgenres
  const sciFiGenres = yield* db.entities.Genres.byGenre({ genre: "Sci-Fi" }).collect()
  // → [
  //   { subgenre: "Robotics", bookTitle: "I, Robot", ... },
  //   { subgenre: "Space Opera", bookTitle: "Foundation", ... },
  // ]

  // All Fantasy subgenres
  const fantasyGenres = yield* db.entities.Genres.byGenre({ genre: "Fantasy" }).collect()
  // → [{ subgenre: "High Fantasy", bookTitle: "The Hobbit", ... }]
  // #endregion
  assertEq(sciFiGenres.length, 2, "2 Sci-Fi genres")
  const sciFiSubgenres = sciFiGenres.map((g) => g.subgenre).sort()
  assertEq(sciFiSubgenres, ["Robotics", "Space Opera"], "Sci-Fi subgenres")
  assertEq(fantasyGenres.length, 1, "1 Fantasy genre")
  assertEq(fantasyGenres[0]!.subgenre, "High Fantasy", "Fantasy subgenre")
  assertEq(fantasyGenres[0]!.bookTitle, "The Hobbit", "Fantasy bookTitle")
  yield* Console.log("  Categories: Sci-Fi (2), Fantasy (1) — OK")

  // -------------------------------------------------------------------------
  // Pattern 7: Loan a book — update Book with memberId + loanEndDate
  //
  // When memberId and loanEndDate are set, the book appears in the loans
  // GSI (gsi1), demonstrating the sparse index pattern.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 7: Loan a Book (update — sparse index)")

  // #region loan-book
  yield* db.entities.Books.update({ isbn: "978-0-547-928227", bookId: "b-hobbit" }).set({
    memberId: "m-alice",
    loanEndDate: "2025-04-01",
    // Must provide all GSI composites for affected indexes
    authorLastName: "Tolkien",
    authorFirstName: "J.R.R.",
    bookTitle: "The Hobbit",
    releaseDate: "1937-09-21",
  })

  // Now the book appears in Alice's loans
  const { Books: aliceLoansAfter } = yield* db.collections.account!({
    memberId: "m-alice",
  }).collect()
  // → [{ bookTitle: "The Hobbit", isbn: "978-0-547-928227", ... }]

  // Bob still has no loans
  const { Books: bobLoans } = yield* db.collections.account!({ memberId: "m-bob" }).collect()
  // → []
  // #endregion
  assertEq(aliceLoansAfter.length, 1, "Alice now has 1 loaned book")
  assertEq(aliceLoansAfter[0]!.bookTitle, "The Hobbit", "loaned book is The Hobbit")
  assertEq(aliceLoansAfter[0]!.isbn, "978-0-547-928227", "loaned book ISBN")
  assertEq(bobLoans.length, 0, "Bob has 0 loans")
  yield* Console.log("  Loan: Book appears in sparse loans index — OK")

  // -------------------------------------------------------------------------
  // Pattern 8: Return a book — atomic transaction to clear loan fields
  //
  // Uses Transaction.transactWrite to atomically:
  // 1. Put the book back with cleared loan fields (memberId/loanEndDate absent)
  // 2. This removes the book from the loans GSI (sparse index)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 8: Return a Book (Transaction)")

  // #region return-book
  yield* Transaction.transactWrite([
    Books.put({
      bookId: "b-hobbit",
      bookTitle: "The Hobbit",
      description: "A fantasy novel about the adventures of Bilbo Baggins",
      publisher: "George Allen & Unwin",
      releaseDate: "1937-09-21",
      authorFirstName: "J.R.R.",
      authorLastName: "Tolkien",
      isbn: "978-0-547-928227",
      // memberId and loanEndDate intentionally omitted -- clears the loan
    }),
  ])

  // Book is no longer in Alice's loans
  const { Books: aliceLoansCleared } = yield* db.collections.account!({
    memberId: "m-alice",
  }).collect()
  // → []

  // But the book still exists and is intact
  const returnedHobbit = yield* db.entities.Books.get({
    isbn: "978-0-547-928227",
    bookId: "b-hobbit",
  })
  // returnedHobbit.bookTitle → "The Hobbit"
  // returnedHobbit.memberId → undefined (cleared)

  // And still appears in author's works
  const { Books: tolkienBooksAfter } = yield* db.collections.works!({
    authorLastName: "Tolkien",
    authorFirstName: "J.R.R.",
  }).collect()
  // → [{ bookTitle: "The Hobbit", ... }]
  // #endregion
  assertEq(aliceLoansCleared.length, 0, "Alice has 0 loans after return")
  assertEq(returnedHobbit.bookTitle, "The Hobbit", "returned book title")
  assertEq(returnedHobbit.authorLastName, "Tolkien", "returned book author")
  assert(returnedHobbit.memberId === undefined, "memberId cleared after return")
  assert(returnedHobbit.loanEndDate === undefined, "loanEndDate cleared after return")
  assertEq(tolkienBooksAfter.length, 1, "Tolkien still has 1 book after return")
  assertEq(tolkienBooksAfter[0]!.bookTitle, "The Hobbit", "Tolkien book is still The Hobbit")
  yield* Console.log("  Return: Book removed from loans index, still in works — OK")

  // --- Cleanup ---
  yield* db.tables["library-table"]!.delete()
  yield* Console.log("\nAll 8 patterns passed.")
})

// =============================================================================
// 8. Provide dependencies and run
// =============================================================================

// #region layer-setup
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  LibTable.layer({ name: "library-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion

export {
  program,
  LibTable,
  LibSchema,
  Authors,
  Books,
  Genres,
  Members,
  Author,
  Book,
  Genre,
  Member,
}
