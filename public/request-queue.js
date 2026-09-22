// 通信枠を「1店舗の全処理」ではなく「1回の取得」に貸し出す。
// 全店の最初の取得が先に並ぶので、追加確認の多い店が他店の開始を塞がない。
// 同じ店舗の続きは呼び出し側で順番に待つため、店舗内の同時アクセス数は増えない。
export function createRequestQueue(limit = 6) {
  const pending=[];
  let active=0;
  function drain() {
    while(active<limit && pending.length) {
      const {task,resolve,reject}=pending.shift(); active++;
      Promise.resolve().then(task).then(resolve,reject).finally(()=>{active--;drain();});
    }
  }
  return {run(task){return new Promise((resolve,reject)=>{pending.push({task,resolve,reject});drain();});}};
}
