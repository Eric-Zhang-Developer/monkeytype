import { simpleGit } from "simple-git";
import { Collection, ObjectId } from "mongodb";
import path from "path";
import { existsSync, writeFileSync } from "fs";
import { readFile } from "node:fs/promises";
import * as db from "../init/db";
import MonkeyError from "../utils/error";
import { compareTwoStrings } from "string-similarity";
import { ApproveQuote, Quote } from "@monkeytype/schemas/quotes";
import { WithObjectId } from "../utils/misc";
import { parseWithSchema as parseJsonWithSchema } from "@monkeytype/util/json";
import { z } from "zod";
import { tryCatchSync } from "@monkeytype/util/trycatch";
import { Language } from "@monkeytype/schemas/languages";

const JsonQuoteSchema = z.object({
  text: z.string(),
  britishText: z.string().optional(),
  approvedBy: z.string().optional(),
  source: z.string(),
  length: z.number(),
  id: z.number(),
});

const QuoteDataSchema = z.object({
  language: z.string(),
  quotes: z.array(JsonQuoteSchema),
  groups: z.array(z.tuple([z.number(), z.number()])),
});

const PATH_TO_REPO = "../../../../monkeytype-new-quotes";

const { data: git, error } = tryCatchSync(() =>
  simpleGit(path.join(__dirname, PATH_TO_REPO))
);

if (error) {
  console.error(`Failed to initialize git: ${error}`);
}

type AddQuoteReturn = {
  languageError?: number;
  duplicateId?: number;
  similarityScore?: number;
};

export type DBNewQuote = WithObjectId<Quote>;

// Export for use in tests
export const getNewQuoteCollection = (): Collection<DBNewQuote> =>
  db.collection<DBNewQuote>("new-quotes");

export async function add(
  text: string,
  source: string,
  language: string,
  uid: string
): Promise<AddQuoteReturn | undefined> {
  if (git === undefined) throw new MonkeyError(500, "Git not available.");
  const quote = {
    _id: new ObjectId(),
    text: text,
    source: source,
    language: language.toLowerCase(),
    submittedBy: uid,
    timestamp: Date.now(),
    approved: false,
  };

  if (!/^\w+$/.test(language)) {
    throw new MonkeyError(500, `Invalid language name`, language);
  }

  const count = await getNewQuoteCollection().countDocuments({
    language: language,
  });

  if (count >= 100) {
    throw new MonkeyError(
      409,
      "There are already 100 quotes in the queue for this language."
    );
  }

  //check for duplicate first
  const fileDir = path.join(
    __dirname,
    `${PATH_TO_REPO}/frontend/static/quotes/${language}.json`
  );
  let duplicateId = -1;
  let similarityScore = -1;
  if (existsSync(fileDir)) {
    const quoteFile = await readFile(fileDir);
    const quoteFileJSON = parseJsonWithSchema(
      quoteFile.toString(),
      QuoteDataSchema
    );
    quoteFileJSON.quotes.every((old) => {
      if (compareTwoStrings(old.text, quote.text) > 0.9) {
        duplicateId = old.id;
        similarityScore = compareTwoStrings(old.text, quote.text);
        return false;
      }
      return true;
    });
  } else {
    return { languageError: 1 };
  }
  if (duplicateId !== -1) {
    return { duplicateId, similarityScore };
  }
  await db.collection("new-quotes").insertOne(quote);
  return undefined;
}

export async function get(language: Language | "all"): Promise<DBNewQuote[]> {
  if (git === undefined) throw new MonkeyError(500, "Git not available.");
  const where: {
    approved: boolean;
    language?: Language;
  } = {
    approved: false,
  };

  if (!/^\w+$/.test(language)) {
    throw new MonkeyError(500, `Invalid language name`, language);
  }

  if (language !== "all") {
    where.language = language;
  }
  return await getNewQuoteCollection()
    .find(where)
    .sort({ timestamp: 1 })
    .limit(10)
    .toArray();
}

type ApproveReturn = {
  quote: ApproveQuote;
  message: string;
};

export async function approve(
  quoteId: string,
  editQuote: string | undefined,
  editSource: string | undefined,
  name: string
): Promise<ApproveReturn> {
  if (git === null) throw new MonkeyError(500, "Git not available.");
  //check mod status
  const targetQuote = await getNewQuoteCollection().findOne({
    _id: new ObjectId(quoteId),
  });
  if (!targetQuote) {
    throw new MonkeyError(
      404,
      "Quote not found. It might have already been reviewed. Please refresh the list."
    );
  }
  const language = targetQuote.language;
  const quote: ApproveQuote = {
    text: editQuote ?? targetQuote.text,
    source: editSource ?? targetQuote.source,
    length: targetQuote.text.length,
    approvedBy: name,
    id: -1,
  };
  let message = "";

  if (!/^\w+$/.test(language)) {
    throw new MonkeyError(500, `Invalid language name`, language);
  }

  const fileDir = path.join(
    __dirname,
    `${PATH_TO_REPO}/frontend/static/quotes/${language}.json`
  );
  await git.pull("upstream", "master");
  if (existsSync(fileDir)) {
    const quoteFile = await readFile(fileDir);
    const quoteObject = parseJsonWithSchema(
      quoteFile.toString(),
      QuoteDataSchema
    );
    quoteObject.quotes.every((old) => {
      if (compareTwoStrings(old.text, quote.text) > 0.8) {
        throw new MonkeyError(409, "Duplicate quote");
      }
    });
    let maxid = 0;
    quoteObject.quotes.map(function (q) {
      if (q.id > maxid) {
        maxid = q.id;
      }
    });
    quote.id = maxid + 1;

    if (quote.id === -1) {
      throw new MonkeyError(500, "Failed to get max id");
    }

    quoteObject.quotes.push(quote);
    writeFileSync(fileDir, JSON.stringify(quoteObject, null, 2));
    message = `Added quote to ${language}.json.`;
  } else {
    //file doesnt exist, create it
    quote.id = 1;
    writeFileSync(
      fileDir,
      JSON.stringify({
        language: language,
        groups: [
          [0, 100],
          [101, 300],
          [301, 600],
          [601, 9999],
        ],
        quotes: [quote],
      })
    );
    message = `Created file ${language}.json and added quote.`;
  }
  await git.add([`frontend/static/quotes/${language}.json`]);
  await git.commit(`Added quote to ${language}.json`);
  await git.push("origin", "master");
  await getNewQuoteCollection().deleteOne({ _id: new ObjectId(quoteId) });
  return { quote, message };
}

export async function refuse(quoteId: string): Promise<void> {
  if (git === undefined) throw new MonkeyError(500, "Git not available.");
  await getNewQuoteCollection().deleteOne({ _id: new ObjectId(quoteId) });
}
