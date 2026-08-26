/* ============================================================
   本文件由 scripts/build_demo_data.py 生成，勿手改；
   数据来源 data/ 目录（采集 runId 见 DB.meta.runIds）。
   数据体量大后拆为 js/db-NNN.js 分片：本文件只做同步加载器，
   解析期 document.write 按序注入分片脚本，全部分片执行完毕
   才轮到后续 <script src="js/app.js">；全局 DB 由最后一片
   内置装配器合成。
   重新生成：python scripts/build_demo_data.py --as-of YYYY-MM-DD
   ============================================================ */

window.DB_PARTS = [];
(function () {
  var files = ["db-000.js", "db-001.js", "db-002.js", "db-003.js"];
  for (var i = 0; i < files.length; i++) {
    document.write('<script src="js/' + files[i] + '"><\/script>');
  }
})();
