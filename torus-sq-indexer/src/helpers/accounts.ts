import { Account } from "../types";
import {ZERO} from "../utils/consts";

export function initAccount(address: string, height: bigint) {
  return Account.create({
    id: address,
    address,
    createdAt: height,
    updatedAt: height,
    balance_free: ZERO,
    balance_staked: ZERO,
    balance_total: ZERO,
  });
}
