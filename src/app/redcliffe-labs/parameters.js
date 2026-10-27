export function normalizeParameters(body) {
  return (Array.isArray(body?.data) ? body.data : []).map((group) => {
    const details = Array.isArray(group?.package_details)
      ? group.package_details
      : Array.isArray(group?.package_detail) ? group.package_detail : [];
    return {
      name: typeof group?.name === 'string' ? group.name.trim() : '',
      parameters: details
        .map((item) => typeof item?.name === 'string' ? item.name.trim() : '')
        .filter(Boolean),
    };
  });
}
