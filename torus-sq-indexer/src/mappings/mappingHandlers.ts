import assert from "assert";
import {
  SubstrateExtrinsic,
  SubstrateEvent,
  SubstrateBlock,
} from "@subql/types";
import {
  Account,
  Block,
  Transfer,
  Event,
  Extrinsic,
  DelegateBalance,
  DelegateAction,
  DelegationEvent,
  Agent
} from "../types";
import {initAccount} from "../helpers";
import {ZERO, formattedNumber, bridged} from "../utils/consts";

export async function fetchExtrinsics(block: SubstrateBlock): Promise<void> {

  const height = block.block.header.number.toBigInt();

  logger.info(`Fetching extrinsics and events at block #${height}`);

  indexExtrinsicsAndEvents(block).then(() => {
    logger.info(`Finished fetching extrinsics and events at block #${height}`)
  });
}
async function indexExtrinsicsAndEvents(block: SubstrateBlock) {

  const height = block.block.header.number.toBigInt();
  const blockHeight = block.block.header.number.toString();
  const extrinsics = block.block.extrinsics;
  const events = block.events;
  // handleGenesisBalances().then(() => logger.info(`fixed genesis xfers`))

  Block.create({
    id: blockHeight,
    height,
    eventCount: events.length,
    extrinsicCount: extrinsics.length,
    timestamp: block.timestamp ?? new Date(),
    hash: block.hash.toString(),
    parentHash: block.block.header.parentHash.toString(),
    specVersion: block.specVersion
  }).save().then(() => logger.info(`Added block #${height}`))

  let eventEntities: Event[] = [];
  for (const [index, event] of events.entries()) {
    const eventid = `${blockHeight}-${formattedNumber(index)}`;
    eventEntities.push(Event.create({
      id: eventid,
      blockNumber: height,
      extrinsicId: event.phase.isApplyExtrinsic ? event.phase.asApplyExtrinsic.toNumber() : -1,
      eventName: event.event.method,
      module: event.event.section,
      data: JSON.stringify(event.event.data)
    }))
  }
  await store.bulkCreate("Event", eventEntities);

  let entities: Extrinsic[] = [];
  for (const [index, extrinsic] of extrinsics.entries()) {
    const extrinsicid = `${blockHeight}-${formattedNumber(index)}`;
    const account = extrinsic.signer.toString();

    const extrinsicEvents = events.filter(({phase}) =>  phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index)).map(({event}) => event);
    const success = extrinsicEvents.some((event) => event.section === 'system' && event.method === 'ExtrinsicSuccess');


    const extrinsicHash = extrinsic.hash.toString();

    entities.push(Extrinsic.create({
          id: extrinsicid,
          module: extrinsic.method.section,
          method: extrinsic.method.method,

          blockNumber: height,
          extrinsicId: index,

          tip: extrinsic.tip.toBigInt(),
          version: extrinsic.version,

          signer: account,
          success: success,
          hash: extrinsicHash,

          args: JSON.stringify(extrinsic.args)
        }
    ))


  }
  await store.bulkCreate("Extrinsic", entities);


}

export async function handleTransfer(event: SubstrateEvent): Promise<void> {
  const {
    idx,
    event: { data },
    block: {
      timestamp,
      block: {
        header: { number },
      },
    },
  } = event;

  const from = data[0].toString();
  const to = data[1].toString();
  const amount = BigInt(data[2].toString());

  const blockNumber = number.toBigInt();
  const extrinsicId = event.phase.asApplyExtrinsic.toPrimitive() as number;

  const entity = Transfer.create({
    id: `${blockNumber.toString()}-${idx}`,
    from,
    to,
    amount,
    blockNumber,
    extrinsicId,
    timestamp: timestamp ?? new Date()
  });


  await incFreeBalance(to, amount, blockNumber);
  await decFreeBalance(from, amount, blockNumber);

  await entity.save();
}

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
export async function fetchDelegations(block: SubstrateBlock): Promise<void> {
  if (!api) return;

  const hash = block.block.header.hash.toString();
  const apiAt = api

  logger.info(`#${block.block.header.number.toNumber()}: fetchDelegations`);
  const height = block.block.header.number.toNumber();

  apiAt.query.torus0.stakingTo.entries().then(async stakeTo => {
    const records: DelegateBalance[] = [];
    logger.info(`#${height}: syncStakedAmount`);
    for (const [key, value] of stakeTo) {
      const [account, agent] = key.toHuman() as [string, string];
      const amount = BigInt(value.toString());

      if (amount === ZERO) continue;

      records.push(
          DelegateBalance.create({
            id: `${account}-${agent}`,
            lastUpdate: height,
            account,
            agent,
            amount,
          })
      );
    }
//     await removeAllDelegateBalanceRecords();
    await store.bulkCreate("DelegateBalance", records);
  })

}

export async function fetchAccounts(block: SubstrateBlock): Promise<void> {

  const height = block.block.header.number.toBigInt();

  logger.info(`Fetching accounts at block #${height}`);

  updateAllAccounts(block).then(() => {
    logger.info(`Finished fetching accounts at block #${height}`)
  });
}

async function updateAllAccounts(block: SubstrateBlock) {
  if (!api) throw new Error("API not initialized");

  const height = block.block.header.number.toBigInt();
  const hash = block.block.header.hash.toString();

  const apiAt = api;

  let entities: Account[] = [];
  const accounts = await apiAt.query.system.account.entries();
  for (const account of accounts) {
    const address = `${account[0].toHuman()}`;
    const freeBalance = BigInt(account[1].data.free.toString());
    const stakedBalance = (await DelegateBalance.getByAccount(address, {limit: 1}))?.reduce(
        (accumulator, delegation) => accumulator + delegation.amount,
        ZERO) ?? ZERO;

    const totalBalance = freeBalance + stakedBalance;

    const existingAccount = await Account.get(address);
    if(existingAccount){
      existingAccount.updatedAt = height;
      existingAccount.balance_free = freeBalance;
      existingAccount.balance_total = totalBalance;
      existingAccount.balance_staked = stakedBalance;
    }else {
      entities.push(
          Account.create({
            id: address,
            address,
            createdAt: height,
            updatedAt: height,
            balance_free: freeBalance,
            balance_staked: stakedBalance,
            balance_total: totalBalance,
          })
      );
    }
  }
  await store.bulkCreate("Account", entities);
  /*
  const pageSize = 1000;
  let currentPage = "0x";
  while (true){
      // @ts-ignore
      const accountStorageKeys = await api._rpcCore.provider.send('state_getKeysPaged', [
              '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9',//account
              pageSize,
              currentPage,
              hash.toString()
          ]
          , false);

      // @ts-ignore
      api._rpcCore.provider.send('state_queryStorageAt',
          [accountStorageKeys, hash.toString()]
          , false).then(async accountStorages => {

          let entities: Account[] = [];

          for (const [key, data] of accountStorages[0].changes) {
              const address = encodeAddress(hexToU8a(key).slice(32 + 16));
              const palletBalancesAccountData = hexToU8a(data).slice(16);
              const freeBalance = new DataView(palletBalancesAccountData.buffer).getBigUint64(0, true);

              const stakedBalance = (await DelegateBalance.getByAccount(address))?.reduce(
                  (accumulator, delegation) => accumulator + delegation.amount,
                  ZERO) ?? ZERO;

              const totalBalance = freeBalance + stakedBalance;

              entities.push(
                  Account.create({
                      id: address,
                      address,
                      createdAt: ZERO,
                      updatedAt: height,
                      balance_free: freeBalance,
                      balance_staked: stakedBalance,
                      balance_total: totalBalance,
                  })
              );
          }

          await store.bulkCreate("Account", entities);
      })

      if (accountStorageKeys.length < pageSize){
          break;
      }else{
          currentPage = accountStorageKeys[accountStorageKeys.length - 1];
      }
  }
  */
}




export async function handleStakeAdded(event: SubstrateEvent): Promise<void> {
  await handleDelegation(event, DelegateAction.DELEGATE);
}

export async function handleStakeRemoved(event: SubstrateEvent): Promise<void> {
  await handleDelegation(event, DelegateAction.UNDELEGATE);
}

const handleDelegation = async (
    event: SubstrateEvent,
    action: DelegateAction
) => {
  if (!event.extrinsic) return;
  const { method } = event.extrinsic.extrinsic.method;
  if (method === "registerAgent") return;
  const height = event.block.block.header.number.toNumber();
  const { data } = event.event;
  const account = data[0].toString();
  const agent = data[1].toString();
  const amount = BigInt(data[2].toString());

  if (amount === ZERO) return;

  const eventRecord = DelegationEvent.create({
    id: `${height}-${account}-${agent}`,
    height,
    extrinsicId: event.extrinsic.idx,
    account,
    agent,
    amount,
    action,
  });
  await eventRecord.save();

  const id = `${account}-${agent}`;

  let balanceRecord = await DelegateBalance.get(id);
  if (!balanceRecord) {
    balanceRecord = DelegateBalance.create({
      id,
      account,
      agent,
      amount: ZERO,
      lastUpdate: height,
    });
  }
  if (action === DelegateAction.DELEGATE) {
    balanceRecord.amount += amount;
  } else {
    balanceRecord.amount -= amount;
    if (balanceRecord.amount < ZERO) {
      balanceRecord.amount = ZERO;
    }
  }
  if (balanceRecord.amount === ZERO) {
    await store.remove("DelegateBalance", id);
    return;
  }
  balanceRecord.lastUpdate = height;
  await balanceRecord.save();
};


export async function handleAgentRegistered(event: SubstrateEvent): Promise<void> {
  if (!event.extrinsic || !api) return;

  const height = event.block.block.header.number.toNumber();
  const { block: { timestamp, block: {header: {hash}} }, event: { data }, extrinsic } = event;

  const key = data[0].toString();

  const {method: {args, method, section}} = event.extrinsic.extrinsic;
  const name = `${args[1].toHuman()}`;
  const metadata = `${args[2].toHuman()}`;

  const entity = Agent.create({
    id: key,
    name,
    metadata,
    registeredAt: height,
    timestamp: timestamp ?? new Date(),
    extrinsicId: extrinsic?.idx ?? -1
  });

  await entity.save();
}

export async function handleAgentUnregistered(event: SubstrateEvent): Promise<void> {
  if (!event.extrinsic || !api) return;

  const {
    event: { data },
  } = event;

  const id = data[0].toString();
  const entity = await Agent.get(id);
  if (!entity) {
    logger.error(`Agent ${id} does not exist.`);
  } else {
    await Agent.remove(id);
  }

}

export const handleGenesisBalances = async () => {
  const bridgedxfers: Transfer[] = [];
  let idx = 0;
  for (const transfer of bridged) {
    const from = 'CommuneBridge';
    const to = transfer[0].toString();
    const amount = BigInt(transfer[1]);

    const blockNumber = BigInt(0);
    const extrinsicId = 0;

    const entity = Transfer.create({
      id: `bridge-${idx++}`,
      from,
      to,
      amount,
      blockNumber,
      extrinsicId,
      timestamp: new Date(1735945860000)
    });
    bridgedxfers.push(entity);
  }

  await store.bulkCreate("Transfer", bridgedxfers);

}
