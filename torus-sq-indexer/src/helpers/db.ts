// // FIXME:
// export async function removeAllRecords<T>(entity: string) {
//   while (true) {
//     const records = await store.getByFields(entity, [["id", "!=", ""]]);
//     if (records.length === 0) break;
//     store.bulkRemove(
//       entity,
//       records.map(({ id }) => id)
//     );
//   }
// }
