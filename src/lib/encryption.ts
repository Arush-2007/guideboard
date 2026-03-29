import Cryptr from "cryptr";

let cryptr: Cryptr | null = null;

const getCryptr = () => {
  if (cryptr) return cryptr;

  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("Missing ENCRYPTION_KEY environment variable");
  }

  cryptr = new Cryptr(key);
  return cryptr;
};

export const encrypt = (text: string) => getCryptr().encrypt(text);
export const decrypt = (text: string) => getCryptr().decrypt(text);
