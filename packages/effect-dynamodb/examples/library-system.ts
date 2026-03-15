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
 *   detail:  Book + Genre by isbn         (primary index)
 *   works:   Author + Book + Genre by author name (gsi2)
 *   account: Member + Book by memberId    (gsi1)
 *   titles:  Book + Genre by bookTitle    (gsi3)
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
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

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

// =============================================================================
// 2. Schema + Table
// =============================================================================

const LibSchema = DynamoSchema.make({ name: "library", version: 1 })
const LibTable = Table.make({ schema: LibSchema })

// =============================================================================
// 3. Entity definitions — 4 entities, 3 GSIs, 4 collections
// =============================================================================

/**
 * Author — 2 indexes (primary + gsi2)
 *
 * Primary: identity key by last name + first name
 * GSI2: "works" collection — author's books and genres
 */
const Authors = Entity.make({
  model: Author,
  table: LibTable,
  entityType: "Author",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["authorLastName"] },
      sk: { field: "sk", composite: ["authorFirstName"] },
    },
    info: {
      index: "gsi2",
      collection: "works",
      pk: { field: "gsi2pk", composite: ["authorLastName", "authorFirstName"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  timestamps: true,
})

/**
 * Book — 4 indexes (primary + 3 GSIs)
 *
 * Primary: copies by isbn + bookId (part of "detail" collection concept)
 * GSI1: loans — sparse index using optional memberId/loanEndDate
 *        When a book is not loaned, memberId is absent, so it won't appear.
 *        Part of "account" collection with Member.
 * GSI2: "works" collection — author's books alongside Author and Genre
 * GSI3: "titles" collection — books and genres by title
 */
const Books = Entity.make({
  model: Book,
  table: LibTable,
  entityType: "Book",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["isbn"] },
      sk: { field: "sk", composite: ["bookId"] },
    },
    loans: {
      index: "gsi1",
      collection: "account",
      pk: { field: "gsi1pk", composite: ["memberId"] },
      sk: { field: "gsi1sk", composite: ["loanEndDate"] },
    },
    author: {
      index: "gsi2",
      collection: "works",
      pk: { field: "gsi2pk", composite: ["authorLastName", "authorFirstName"] },
      sk: { field: "gsi2sk", composite: ["bookId"] },
    },
    releases: {
      index: "gsi3",
      collection: "titles",
      pk: { field: "gsi3pk", composite: ["bookTitle"] },
      sk: { field: "gsi3sk", composite: ["releaseDate"] },
    },
  },
  timestamps: true,
})

/**
 * Genre — 4 indexes (primary + 3 GSIs)
 *
 * Primary: genres by isbn + genre + subgenre (alongside Book in "detail" concept)
 * GSI1: categories — standalone genre browsing
 * GSI2: "works" collection — genres alongside Author and Book
 * GSI3: "titles" collection — genres alongside Book by title
 */
const Genres = Entity.make({
  model: Genre,
  table: LibTable,
  entityType: "Genre",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["isbn"] },
      sk: { field: "sk", composite: ["genre", "subgenre"] },
    },
    categories: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["genre"] },
      sk: { field: "gsi1sk", composite: ["subgenre"] },
    },
    author: {
      index: "gsi2",
      collection: "works",
      pk: { field: "gsi2pk", composite: ["authorLastName", "authorFirstName"] },
      sk: { field: "gsi2sk", composite: ["genre"] },
    },
    title: {
      index: "gsi3",
      collection: "titles",
      pk: { field: "gsi3pk", composite: ["bookTitle"] },
      sk: { field: "gsi3sk", composite: ["genre", "subgenre"] },
    },
  },
  timestamps: true,
})

/**
 * Member — 2 indexes (primary + gsi1)
 *
 * Primary: identity key by memberId
 * GSI1: "account" collection — member info alongside their loaned books
 */
const Members = Entity.make({
  model: Member,
  table: LibTable,
  entityType: "Member",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["memberId"] },
      sk: { field: "sk", composite: [] },
    },
    account: {
      index: "gsi1",
      collection: "account",
      pk: { field: "gsi1pk", composite: ["memberId"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
  timestamps: true,
})

// =============================================================================
// 4. Seed data
// =============================================================================

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

// =============================================================================
// 5. Helpers
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
// 6. Main program — 8 access patterns with assertions
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // --- Setup: create table ---
  yield* client.createTable({
    TableName: "library-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(LibTable, [Authors, Books, Genres, Members]),
  })

  // --- Seed data ---
  for (const author of Object.values(authors)) {
    yield* Authors.put(author)
  }
  for (const book of Object.values(books)) {
    yield* Books.put(book)
  }
  for (const g of Object.values(genres)) {
    yield* Genres.put(g)
  }
  for (const member of Object.values(members)) {
    yield* Members.put(member)
  }

  // -------------------------------------------------------------------------
  // Pattern 1: Get author by name (primary key)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 1: Get Author by Name (primary)")

  const tolkien = yield* Authors.get({
    authorLastName: "Tolkien",
    authorFirstName: "J.R.R.",
  })
  assertEq(tolkien.authorFirstName, "J.R.R.", "tolkien firstName")
  assertEq(tolkien.authorLastName, "Tolkien", "tolkien lastName")
  assertEq(tolkien.birthday, "1892-01-03", "tolkien birthday")
  assert(tolkien.bio.includes("philologist"), "tolkien bio")

  const asimov = yield* Authors.get({
    authorLastName: "Asimov",
    authorFirstName: "Isaac",
  })
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

  const hobbit = yield* Books.get({
    isbn: "978-0-547-928227",
    bookId: "b-hobbit",
  })
  assertEq(hobbit.bookTitle, "The Hobbit", "hobbit title")
  assertEq(hobbit.authorLastName, "Tolkien", "hobbit author")
  assertEq(hobbit.releaseDate, "1937-09-21", "hobbit releaseDate")
  assertEq(hobbit.publisher, "George Allen & Unwin", "hobbit publisher")

  // Genre for the same ISBN — querying Genre's primary by isbn
  // Since Genre has composite SK [genre, subgenre], we get by full key
  const hobbitGenre = yield* Genres.get({
    isbn: "978-0-547-928227",
    genre: "Fantasy",
    subgenre: "High Fantasy",
  })
  assertEq(hobbitGenre.genre, "Fantasy", "hobbit genre")
  assertEq(hobbitGenre.subgenre, "High Fantasy", "hobbit subgenre")
  assertEq(hobbitGenre.bookTitle, "The Hobbit", "hobbit genre bookTitle")
  yield* Console.log("  Detail: Book + Genre by ISBN — OK")

  // -------------------------------------------------------------------------
  // Pattern 3: Author's works — books + genres by author (gsi2 "works")
  //
  // The "works" collection on gsi2 groups Author, Book, and Genre by
  // authorLastName + authorFirstName. Query each entity's GSI method
  // to retrieve all of an author's associated items.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 3: Author's Works (gsi2 — works collection)")

  const asimovBooks = yield* Query.collect(
    Books.query.author({ authorLastName: "Asimov", authorFirstName: "Isaac" }),
  )
  assertEq(asimovBooks.length, 2, "Asimov has 2 books")
  const asimovTitles = asimovBooks.map((b) => b.bookTitle).sort()
  assertEq(asimovTitles, ["Foundation", "I, Robot"], "Asimov book titles")

  const asimovGenres = yield* Query.collect(
    Genres.query.author({ authorLastName: "Asimov", authorFirstName: "Isaac" }),
  )
  assertEq(asimovGenres.length, 2, "Asimov has 2 genres")
  const asimovSubgenres = asimovGenres.map((g) => g.subgenre).sort()
  assertEq(asimovSubgenres, ["Robotics", "Space Opera"], "Asimov subgenres")

  const tolkienBooks = yield* Query.collect(
    Books.query.author({ authorLastName: "Tolkien", authorFirstName: "J.R.R." }),
  )
  assertEq(tolkienBooks.length, 1, "Tolkien has 1 book")
  assertEq(tolkienBooks[0]!.bookTitle, "The Hobbit", "Tolkien book title")

  // Author's own record in the works collection
  const tolkienInfo = yield* Query.collect(
    Authors.query.info({ authorLastName: "Tolkien", authorFirstName: "J.R.R." }),
  )
  assertEq(tolkienInfo.length, 1, "Tolkien has 1 author record in works")
  assertEq(tolkienInfo[0]!.birthday, "1892-01-03", "Tolkien birthday from works")
  yield* Console.log("  Works: Author + Books + Genres by author — OK")

  // -------------------------------------------------------------------------
  // Pattern 4: Member account — member info + loaned books (gsi1 "account")
  //
  // Before any loans, Member.query.account returns the member only.
  // After loaning a book, Book.query.loans returns the loaned book.
  // Both share gsi1 via the "account" collection.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 4: Member Account (gsi1 — account collection)")

  // Before loans: member record only
  const aliceAccount = yield* Query.collect(Members.query.account({ memberId: "m-alice" }))
  assertEq(aliceAccount.length, 1, "Alice has 1 account record (no loans yet)")
  assertEq(aliceAccount[0]!.city, "New York", "Alice city")
  assertEq(aliceAccount[0]!.state, "NY", "Alice state")

  // No loaned books yet — sparse index means Books won't appear in gsi1
  const aliceLoans = yield* Query.collect(Books.query.loans({ memberId: "m-alice" }))
  assertEq(aliceLoans.length, 0, "Alice has 0 loaned books initially")
  yield* Console.log("  Account: Member info (no loans yet) — OK")

  // -------------------------------------------------------------------------
  // Pattern 5: Books by title (gsi3 "titles" collection)
  //
  // Book and Genre share gsi3 with PK=bookTitle. Query each entity's
  // GSI method to find items by title.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 5: Books by Title (gsi3 — titles collection)")

  const foundationByTitle = yield* Query.collect(Books.query.releases({ bookTitle: "Foundation" }))
  assertEq(foundationByTitle.length, 1, "1 book titled Foundation")
  assertEq(foundationByTitle[0]!.isbn, "978-0-553-293357", "Foundation ISBN")
  assertEq(foundationByTitle[0]!.releaseDate, "1951-06-01", "Foundation release")

  const foundationGenresByTitle = yield* Query.collect(
    Genres.query.title({ bookTitle: "Foundation" }),
  )
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

  const sciFiGenres = yield* Query.collect(Genres.query.categories({ genre: "Sci-Fi" }))
  assertEq(sciFiGenres.length, 2, "2 Sci-Fi genres")
  const sciFiSubgenres = sciFiGenres.map((g) => g.subgenre).sort()
  assertEq(sciFiSubgenres, ["Robotics", "Space Opera"], "Sci-Fi subgenres")

  const fantasyGenres = yield* Query.collect(Genres.query.categories({ genre: "Fantasy" }))
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

  const loanedHobbit = yield* Books.update({
    isbn: "978-0-547-928227",
    bookId: "b-hobbit",
  }).pipe(
    Books.set({
      memberId: "m-alice",
      loanEndDate: "2025-04-01",
      // Must provide all GSI composites for affected indexes.
      // loans (gsi1): memberId + loanEndDate
      // author (gsi2): authorLastName + authorFirstName + bookId
      // releases (gsi3): bookTitle + releaseDate
      authorLastName: "Tolkien",
      authorFirstName: "J.R.R.",
      bookTitle: "The Hobbit",
      releaseDate: "1937-09-21",
    }),
  )
  assertEq(loanedHobbit.memberId, "m-alice", "loaned memberId")
  assertEq(loanedHobbit.loanEndDate, "2025-04-01", "loaned endDate")
  assertEq(loanedHobbit.bookTitle, "The Hobbit", "loaned title preserved")

  // Now the book appears in Alice's loans via sparse index
  const aliceLoansAfter = yield* Query.collect(Books.query.loans({ memberId: "m-alice" }))
  assertEq(aliceLoansAfter.length, 1, "Alice now has 1 loaned book")
  assertEq(aliceLoansAfter[0]!.bookTitle, "The Hobbit", "loaned book is The Hobbit")
  assertEq(aliceLoansAfter[0]!.isbn, "978-0-547-928227", "loaned book ISBN")

  // Bob still has no loans
  const bobLoans = yield* Query.collect(Books.query.loans({ memberId: "m-bob" }))
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

  // Re-put the book without loan fields to clear the sparse index entry
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
      // memberId and loanEndDate intentionally omitted — clears the loan
    }),
  ])

  // Verify: book is returned (no longer in loans index)
  const aliceLoansCleared = yield* Query.collect(Books.query.loans({ memberId: "m-alice" }))
  assertEq(aliceLoansCleared.length, 0, "Alice has 0 loans after return")

  // Verify: book still exists and is intact
  const returnedHobbit = yield* Books.get({
    isbn: "978-0-547-928227",
    bookId: "b-hobbit",
  })
  assertEq(returnedHobbit.bookTitle, "The Hobbit", "returned book title")
  assertEq(returnedHobbit.authorLastName, "Tolkien", "returned book author")
  // memberId should be absent after return
  assert(returnedHobbit.memberId === undefined, "memberId cleared after return")
  assert(returnedHobbit.loanEndDate === undefined, "loanEndDate cleared after return")

  // Verify: book still appears in author's works
  const tolkienBooksAfter = yield* Query.collect(
    Books.query.author({ authorLastName: "Tolkien", authorFirstName: "J.R.R." }),
  )
  assertEq(tolkienBooksAfter.length, 1, "Tolkien still has 1 book after return")
  assertEq(tolkienBooksAfter[0]!.bookTitle, "The Hobbit", "Tolkien book is still The Hobbit")
  yield* Console.log("  Return: Book removed from loans index, still in works — OK")

  // --- Cleanup ---
  yield* client.deleteTable({ TableName: "library-table" })
  yield* Console.log("\nAll 8 patterns passed.")
})

// =============================================================================
// 7. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  LibTable.layer({ name: "library-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)

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
