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
  Agent, ChainInfo, BridgeAction, BridgeTransfer
} from "../types";
import {decFreeBalance, incFreeBalance, initAccount, stakeBalance, unstakeBalance} from "../helpers";
import {ZERO, formattedNumber, bridged} from "../utils/consts";

export async function fetchExtrinsics(block: SubstrateBlock): Promise<void> {

  const height = block.block.header.number.toBigInt();

  logger.info(`Fetching extrinsics and events at block #${height}`);

  await indexExtrinsicsAndEvents(block).then(() => {
    logger.info(`Finished fetching extrinsics and events at block #${height}`)
  });
}

async function getHistoricalDeposits(){
  async function processAllTransfers() {
    const toAddress = '5DDXwRsgvdfukGZbq2o27n43qyDaAnZ6rsfeckGxnaQ1ih2D';
    const pageSize = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const results = await Transfer.getByTo(toAddress, {
        limit: pageSize,
        offset: offset
      });

      if (!results || results.length === 0) {
        hasMore = false;
        break;
      }

      for (const transfer of results) {
        const events = await Event.getByFields([
          ["blockNumber", "=", transfer.blockNumber],
          ["extrinsicId", "=", transfer.extrinsicId],
        ], {limit:100});
        let evmAddress = JSON.parse(events.filter(event => event.eventName === 'Executed')[0].data)[0];

        const result = await Transfer.getByTo(transfer.from, {
          limit: 1
        });
        if (result && result[0]) {
          const bridger = result[0].from;

          await BridgeTransfer.create({
            id: transfer.id,
            address: bridger,
            evmAddress,
            intermediaryAddress: transfer.from,
            amountBridged: transfer.amount,
            toBase: true
          }).save();
        }
      }

      offset += results.length;
      if (results.length < pageSize) {
        hasMore = false;
      }
    }
  }

  // while (true){
  //   const allDelegated = await BridgeAction.getByFields([], {limit: 100})
  //   await store.bulkRemove("BridgeAction", allDelegated.map(delegated => delegated.id))
  //   logger.info('removing old bridgeaction records');
  //   if (allDelegated.length < 100) break;
  // }

  processAllTransfers();

  //
  // const stopat = 258754;
  // //
  // logger.info('start fix block hashes');
  // for (let i = 1; i < stopat; i++) {
  //   let block = await Block.get(`${i}`);
  //     if(block){
  //       unsafeApi?.rpc.chain.getBlockHash(i).then(hash => {
  //         block.hash = hash.toString();
  //         if(i > 1) {
  //           unsafeApi?.rpc.chain.getBlockHash(i - 1).then(hash => {
  //             block.parentHash = hash.toString();
  //             if (i % 1000 === 0) {
  //               logger.info(`FIX BLOCK ${i}`)
  //             }
  //             block.save();
  //           })
  //         }else{
  //           block.parentHash = "0x0e00b212768e28b176d069890c106e37c331ea9b16b207f4e9baf67b3f3f3021";
  //           block.save();
  //         }
  //       })
  //     }
  // }
}

let fixblockhashes = false;

async function indexExtrinsicsAndEvents(block: SubstrateBlock) {
  // if(!fixblockhashes){
  //   getHistoricalDeposits();
  //   fixblockhashes = true;
  // }

  const height = block.block.header.number.toNumber();
  const blockHeight = block.block.header.number.toString();


  const hash = block.block.header.hash.toHex();//await unsafeApi?.rpc.chain.getBlockHash(height);


  const parentHash = block.block.header.parentHash.toString();//await api.query.system.blockHash(parentHeight);
  const extrinsics = block.block.extrinsics;
  const events = block.events;

  Block.create({
    id: blockHeight,
    height,
    eventCount: events.length,
    extrinsicCount: extrinsics.length,
    timestamp: block.timestamp ?? new Date(),
    hash,
    parentHash,
    specVersion: block.specVersion
  }).save().then(() => {
    logger.info(`Added block #${height}`)
  });

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

  const blockNumber = number.toNumber();
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

  if(to === '5DDXwRsgvdfukGZbq2o27n43qyDaAnZ6rsfeckGxnaQ1ih2D'){
    //base deposit
    Transfer.getByTo(from, {
      limit: 1
    }).then(result => {
      Event.getByFields([
        ["blockNumber", "=", blockNumber],
        ["extrinsicId", "=", extrinsicId],
      ], {limit:100}).then(events => {
        let evmAddress = JSON.parse(events.filter(event => event.eventName === 'Executed')[0].data)[0];

        if(result[0]){
          const bridger = result[0].from;
          BridgeTransfer.create({
            id: `${blockNumber.toString()}-${idx}`,
            address: bridger,
            evmAddress,
            intermediaryAddress: from,
            amountBridged: amount,
            toBase: true
          }).save();
        }
      })

    })
  }

  await incFreeBalance(to, amount, blockNumber);
  await decFreeBalance(from, amount, blockNumber);

  await entity.save();
}


export async function fetchDelegations(block: SubstrateBlock): Promise<void> {
  if (!api) return;

  const apiAt = api

  logger.info(`#${block.block.header.number.toNumber()}: fetchDelegations`);
  const height = block.block.header.number.toNumber();

  apiAt.query.torus0.stakingTo.entries().then(async stakeTo => {
    const records: DelegateBalance[] = [];
    // logger.info(`#${height}: syncStakedAmount`);
    let stakingAccounts: string[] = [];

    for (const [key, value] of stakeTo) {
      const [account, agent] = key.toHuman() as [string, string];
      const amount = BigInt(value.toString());

      if (amount === ZERO) continue;

      stakingAccounts.includes(account) || stakingAccounts.push(account);

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

    //killed accounts fix
    for (const stakingAccount of stakingAccounts) {
      api.query.system.account(stakingAccount).then(acc =>{
        let freebalance = BigInt(acc.data.free.toString());
        if(freebalance === ZERO){
          Account.get(stakingAccount).then(async killedAccount => {
            if (killedAccount) {
              const stakedBalance = (await DelegateBalance.getByAccount(stakingAccount, {limit: 100}))?.reduce(
                  (accumulator, delegation) => accumulator + delegation.amount,
                  ZERO) ?? ZERO;

                killedAccount.balance_total = stakedBalance;
                killedAccount.balance_free = ZERO;
                killedAccount.balance_staked = stakedBalance;
                killedAccount.updatedAt = height;
                await killedAccount.save();
            }
          })
        }
      });
    }

  })

}

export async function fetchAccounts(block: SubstrateBlock): Promise<void> {
  const height = block.block.header.number.toBigInt();

  logger.info(`Fetching accounts at block #${height}`);
  //
  updateAllAccounts(block).then(() => {
    logger.info(`Finished fetching accounts at block #${height}`)
  });

  updateAllAgents(block).then(() =>{
    // logger.info(`Finished updating agents at block #${height}`)
  })
  api.query.balances.totalIssuance().then(circulating => {
    ChainInfo.create({id: 'CircSupply', value: circulating.toString(), updatedAt: new Date()}).save().then(() => {
      logger.info(`#${height}: sync CircSupply`);
    });
  });
  api.query.torus0.totalStake().then(totalStake => {
    ChainInfo.create({id: 'TotalStake', value: totalStake.toString(), updatedAt: new Date()}).save().then(() => {
      logger.info(`#${height}: sync TotalStake`);
    });
  })

}

async function updateAllAgents(block: SubstrateBlock){
  // logger.info(` sync agents start`);//309082
try {
  const agentEntries = await api.query.torus0.agents.entries();
  for (let agent of agentEntries) {
    let [args, agentInfo] = agent;
    let [keyParam] = args.args;
    const key = `${keyParam.toHuman()}`;
    let info: any = agentInfo.toHuman();
    // logger.info(key);
    // logger.info(JSON.stringify(info));

    Agent.get(key).then(existingAgent => {
      if (existingAgent) {
        existingAgent.name = info.name;
        existingAgent.url = info.url;
        existingAgent.metadata = info.metadata;
        existingAgent.weightPenaltyFactor = info.weightPenaltyFactor;
        existingAgent.weightControlFee = info.fees.weightControlFee;
        existingAgent.stakingFee = info.fees.stakingFee;
        existingAgent.save();
      } else {
        const entity = Agent.create({
          id: key,
          name: info.name,
          metadata: info.metadata,
          url: info.url,
          stakingFee: info.fees.stakingFee,
          weightControlFee: info.fees.weightControlFee,
          weightPenaltyFactor: info.weightPenaltyFactor,
          registeredAt: Number(info.registrationBlock.replace(',', '')),
          timestamp: new Date(),
          extrinsicId: -1
        });
        entity.save();
      }
    });

  }
}catch (e) {
  logger.info(`ERROR:::: ${e}`);

}


}

async function handleKillAccount(event: SubstrateEvent): Promise<void> {
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
    logger.info(JSON.stringify(data));
    Account.get(data[0].toString()).then(async account => {
      if (account) {
        account.balance_free = BigInt(0);
        await account.save();
      }
    })
}


async function updateAllAccounts(block: SubstrateBlock) {

  if (!api) throw new Error("API not initialized");
try{


  const height = block.block.header.number.toNumber();
  const hash = block.block.header.hash.toString();

  const apiAt = api;

  let entities: Account[] = [];
  const accounts = await apiAt.query.system.account.entries();

  for (const account of accounts) {
    const address = `${account[0].toHuman()}`;

    const freeBalance = BigInt(account[1].data.free.toString());
    const stakedBalance = (await DelegateBalance.getByAccount(address, {limit: 100}))?.reduce(
        (accumulator, delegation) => accumulator + delegation.amount,
        ZERO) ?? ZERO;

    const totalBalance = freeBalance + stakedBalance;

    const existingAccount = await Account.get(address);

    if(existingAccount){
      existingAccount.updatedAt = height;
      existingAccount.balance_free = freeBalance;
      existingAccount.balance_total = totalBalance;
      existingAccount.balance_staked = stakedBalance;
      existingAccount.save().then(() =>{
        //saved
      })
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
}catch (e) {
  logger.info(`ACCOUNTS ERROR ${e}`);
}
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
    const {method} = event.extrinsic.extrinsic.method;
    if (method === "registerAgent") return;
    const height = event.block.block.header.number.toNumber();
    const {data} = event.event;
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
      stakeBalance(account, amount, event.block.block.header.number.toNumber());
    } else {
      balanceRecord.amount -= amount;
      unstakeBalance(account, amount, event.block.block.header.number.toNumber());
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
  const url = `${args[3].toHuman()}`;
  const metadata = `${args[2].toHuman()}`;

  const entity = Agent.create({
    id: key,
    name,
    metadata,
    url,
    stakingFee: '',
    weightControlFee: '',
    weightPenaltyFactor: '',
    registeredAt: height,
    timestamp: timestamp ?? new Date(),
    extrinsicId: extrinsic?.idx ?? -1
  });

  entity.save().then(r => {});
}

export async function handleAgentUpdated(event: SubstrateEvent): Promise<void> {

  if (!event.extrinsic || !api) return;

  const height = event.block.block.header.number.toNumber();
  const { block: { timestamp, block: {header: {hash}} }, event: { data }, extrinsic } = event;

  const key = data[0].toString();

  const {method: {args, method, section}} = event.extrinsic.extrinsic;
  const name = `${args[1].toHuman()}`;
  const url = `${args[3].toHuman()}`;
  const metadata = `${args[2].toHuman()}`;
  Agent.get(key).then(existingAgent => {
    if(existingAgent){
      api.query.torus0.agents(key).then(agentInfo => {
        let info: any = agentInfo.toHuman();
        existingAgent.name = info.name;
        existingAgent.url = info.url;
        existingAgent.metadata = info.metadata;
        existingAgent.weightPenaltyFactor = info.weightPenaltyFactor;
        existingAgent.weightControlFee = info.fees.weightControlFee;
        existingAgent.stakingFee = info.fees.stakingFee;
        existingAgent.save();
      });

    }
  });

  // await entity.save();
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

    const blockNumber = Number(0);
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
