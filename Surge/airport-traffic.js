const SUB_URL = $argument;

if (!SUB_URL) {
  $done({
    title: "机场流量",
    content: "未配置订阅地址",
    style: "error"
  });
}

$httpClient.get({
  url: SUB_URL,
  headers: {
    "User-Agent": "Surge"
  }
}, function(error, response, data) {

  if (error || !response) {
    $done({
      title: "机场流量",
      content: "获取订阅信息失败",
      style: "error"
    });
    return;
  }

  const headers = response.headers || {};

  const info =
    headers["subscription-userinfo"] ||
    headers["Subscription-Userinfo"] ||
    headers["Subscription-UserInfo"];

  if (!info) {
    $done({
      title: "机场流量",
      content: "未找到 subscription-userinfo",
      style: "alert"
    });
    return;
  }

  const usage = {};

  info.split(";").forEach(item => {
    const [key, value] = item.trim().split("=");

    if (key && value !== undefined) {
      usage[key] = Number(value);
    }
  });

  const upload = usage.upload || 0;
  const download = usage.download || 0;
  const total = usage.total || 0;
  const expire = usage.expire || 0;

  const used = upload + download;
  const remain = Math.max(total - used, 0);

  function formatTraffic(bytes) {
    const GB = 1024 ** 3;
    const TB = 1024 ** 4;

    if (bytes >= TB) {
      return (bytes / TB).toFixed(2) + " TB";
    }

    return (bytes / GB).toFixed(2) + " GB";
  }

  const usedPercent =
    total > 0
      ? (used / total * 100).toFixed(1)
      : "0.0";

  let content =
    `剩余：${formatTraffic(remain)} / ${formatTraffic(total)}\n` +
    `已用：${usedPercent}%`;

  if (expire > 0) {
    const date = new Date(expire * 1000);

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");

    content += `\n到期：${yyyy}-${mm}-${dd}`;
  }

  let style = "good";

  if (total > 0) {
    const remainPercent = remain / total;

    if (remainPercent <= 0.1) {
      style = "error";
    } else if (remainPercent <= 0.2) {
      style = "alert";
    }
  }

  $done({
    title: "机场流量",
    content: content,
    style: style
  });
});
