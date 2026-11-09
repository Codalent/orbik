/**
 * The standard names a Library's folders use when the subject exists on the site.
 *
 * The folder set stays the agent's judgement per site — that decision has not changed — but the
 * *names* no longer are. Two consultancies were getting `clients` and `customers`, `engagement`
 * and `pricing`, `positioning` and `competitors`, for the same material; and a consuming agent
 * that has to guess which of a synonym pair this workspace chose is back to reading everything to
 * find its way in, which is precisely what the Library exists to stop.
 *
 * So the rule is narrow and it is about naming, not about structure:
 *
 * - Use the standard name when the site has that subject.
 * - Never invent a synonym for one of these — `clients` is `customers`, `plans` is `pricing`.
 * - Create a folder outside this list only when the site genuinely has a subject the list lacks,
 *   and say why in the folder's summary.
 * - Never create a folder to match the list. A folder with nothing in it is worse than a missing
 *   one: it tells a reader the subject was covered and found empty.
 *
 * It is a list of names with what belongs under each, rather than a schema: nothing validates
 * against it, because a validator would turn "the site has no pricing page" into a failed write.
 *
 * They are the names of *subjects*, not of root paths. The top level is a few numbered folders a
 * person chose (`./structure.js`), and a subject is filed inside one of them:
 * `/02-offer/services`, or `/offer/services` once somebody renames the folder. An agent finds where
 * a subject lives from `library.tree`, never by assuming `/services`. Every folder and file also
 * has a title of its own, so `buyers` can be titled "Buyers & ICP" in one Library and "Who it is
 * for" in another.
 */

/**
 * One entry per standard folder: the path segment, and what belongs in it.
 *
 * The descriptions are written to be read by the model that files into them, which is why they say
 * what goes *in* rather than what the word means.
 */
const LIBRARY_STANDARD_FOLDERS = Object.freeze([
  Object.freeze({ name: "about", holds: "the company's own account of itself: its story, what it stands for, where it is" }),
  Object.freeze({ name: "team", holds: "the people, how the company is run, how it hires" }),
  Object.freeze({ name: "services", holds: "what the company does for its customers, one file per service or practice area" }),
  Object.freeze({ name: "products", holds: "things the company sells as products, one file each" }),
  Object.freeze({ name: "features", holds: "capabilities of a product, when the site describes them separately from the product" }),
  Object.freeze({ name: "pricing", holds: "prices, plans, and how the company engages and bills" }),
  Object.freeze({ name: "process", holds: "how the company works with a customer once they have bought: onboarding, delivery, tooling, service levels" }),
  Object.freeze({ name: "faqs", holds: "the questions the site answers and the objections it addresses, with what it says to each" }),
  Object.freeze({ name: "case-studies", holds: "the pieces of work the site describes in detail: a summary of what they show together, with the pages themselves shown beneath it" }),
  Object.freeze({ name: "customers", holds: "named customers, the sectors they are in, and what the site says it did for them" }),
  Object.freeze({ name: "testimonials", holds: "what customers are quoted as saying, word for word, with who said it" }),
  Object.freeze({ name: "industries", holds: "the sectors the company sells into, when the site organises itself that way" }),
  Object.freeze({ name: "buyers", holds: "who the site says it is for: the kinds of buyer, the problems they arrive with, what makes them look" }),
  Object.freeze({ name: "competitors", holds: "who the site positions against, and how it says it differs" }),
  Object.freeze({ name: "content", holds: "what the company publishes, how often, about what — written from the site map's counts, titles and dates, never from reading the archive" }),
  Object.freeze({ name: "open-questions", holds: "what a reader would want to know that the site never says" }),
]);

/** Every standard subject name, in the order the list gives them. */
export const LIBRARY_STANDARD_FOLDER_NAMES = Object.freeze(LIBRARY_STANDARD_FOLDERS.map((folder) => folder.name));

/**
 * The vocabulary as the lines an agent's instructions carry.
 *
 * Rendered from the list rather than written out in the definition, so the instructions and the
 * list cannot disagree about what the standard names are.
 *
 * @returns {string} one `- name — what belongs in it` line per folder
 */
export function describeStandardFolders() {
  return LIBRARY_STANDARD_FOLDERS.map((folder) => `- \`${folder.name}\` — ${folder.holds}`).join("\n");
}
