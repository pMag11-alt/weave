/** Names, colours and replica ids for people in a room. */

export const PALETTE = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

const ADJECTIVES = ["Brave", "Calm", "Clever", "Eager", "Gentle", "Jolly", "Lucky", "Nimble", "Quiet", "Swift", "Witty", "Zesty"];
const ANIMALS = ["Otter", "Falcon", "Panda", "Lynx", "Heron", "Koala", "Badger", "Gecko", "Orca", "Ibis", "Marten", "Yak"];

export function randomName(): string {
  const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

/** A fresh replica id per page load: ids must never be reused with a different history. */
export function replicaId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}
