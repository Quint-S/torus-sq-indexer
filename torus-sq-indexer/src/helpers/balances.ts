
import { initAccount } from "./accounts";
import {Account} from "../types";
import {ZERO} from "../utils/consts";

export async function incFreeBalance(
    address: string,
    amount: bigint,
    height: bigint
): Promise<void> {
  let entity = await Account.get(address);
  if (!entity) {
    entity = initAccount(address, height);
  }

  if (!(entity.createdAt === height && entity.balance_free !== ZERO)) {
    entity.updatedAt = height;
    entity.balance_free += amount;
    entity.balance_total += amount;
  }

  await entity.save();
}

export async function decFreeBalance(
    address: string,
    amount: bigint,
    height: bigint
): Promise<void> {
  let entity = await Account.get(address);

  if (!entity) return;

  let dec = entity.balance_free < amount ? entity.balance_free : amount;

  entity.updatedAt = height;
  entity.balance_free -= dec;
  entity.balance_total -= dec;

  await entity.save();
}

export async function stakeBalance(
    address: string,
    amount: bigint,
    height: bigint
): Promise<void> {
  let entity = await Account.get(address);
  if (!entity) {
    return;
  }

  entity.updatedAt = height;
  entity.balance_staked += amount;
  entity.balance_free -= amount;

  await entity.save();
}

export async function unstakeBalance(
    address: string,
    amount: bigint,
    height: bigint
): Promise<void> {
  let entity = await Account.get(address);

  if (!entity) return;

  let dec = entity.balance_staked < amount ? entity.balance_staked : amount;

  entity.updatedAt = height;
  entity.balance_free += dec;
  entity.balance_staked -= dec;

  await entity.save();
}