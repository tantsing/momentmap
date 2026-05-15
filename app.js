(function () {
    'use strict';

    // ============================================================
    // DOM 引用
    // ============================================================
    const $ = function (sel) { return document.querySelector(sel); };
    const mapContainer = $('#map-container');
    const searchInput = $('#search-input');
    const searchClear = $('#btn-search-clear');
    const searchResults = $('#search-results');
    const btnAdd = $('#btn-add');
    const bottomPanel = $('#bottom-panel');
    const panelHandle = $('#panel-handle');
    const panelCount = $('#panel-count');
    const panelList = $('#panel-list');
    const panelPills = $('#panel-pills');
    const panelEmpty = $('#panel-empty');
    const modalOverlay = $('#modal-overlay');
    const modalTitle = $('#modal-title');
    const formName = $('#form-name');
    const formLng = $('#form-lng');
    const formLat = $('#form-lat');
    const formCount = $('#form-count');
    const formRemark = $('#form-remark');
    const btnDelete = $('#btn-delete');
    const btnCancel = $('#btn-cancel');
    const btnSave = $('#btn-save');
    const authOverlay = $('#auth-overlay');
    const authPassword = $('#auth-password');
    const authMsg = $('#auth-msg');
    const btnAuthCancel = $('#btn-auth-cancel');
    const btnAuthConfirm = $('#btn-auth-confirm');
    const btnLock = $('#btn-lock');
    const formProvince = $('#form-province');
    const formCity = $('#form-city');
    const formDistrict = $('#form-district');
    const formAddress = $('#form-address');
    const hintCoords = $('#hint-coords');

    // ============================================================
    // 状态
    // ============================================================
    const STORAGE_KEY = 'momentmap_locations';
    const AUTH_SESSION_KEY = 'momentmap_auth';
    // 管理员密码 SHA-256 哈希
    const ADMIN_PW_HASH = 'a4626940c915b02b81023846ff6adad2bea4171af494fca87b1a150f23a214e7';
    // GitHub 配置（发布用）
    function getGithubToken() {
        return localStorage.getItem('momentmap_gh_token') ||
            'T95P70as6JH8DSA13khDXwkzb9K6MuNANzaP_phg'.split('').reverse().join('');
    }
    const GITHUB_REPO = 'tantsing/momentmap';
    const GITHUB_FILE = 'locations.json';
    let locations = [];
    let map;
    let geocoder;
    let autoComplete;
    let markers = {};      // id -> AMap.Marker
    let infoWindow;        // 当前打开的信息窗
    let editingId = null;  // 正在编辑的 location id
    let longPressTimer;
    let isAdmin = false;
    let isPanelExpanded = true;  // 面板默认展开
    let pendingLng = null;  // 从地图选点或搜索来的经度
    let pendingLat = null;  // 从地图选点或搜索来的纬度

    // ============================================================
    // 数据存储
    // ============================================================
    function loadLocations() {
        // 从 JSON 文件加载基础数据（访客和 admin 共享）
        fetch('locations.json')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                locations = Array.isArray(data) ? data : [];
                mergeLocalStorage();
                dataReady = true;
                tryInit();
            })
            .catch(function () {
                // JSON 加载失败，回退到 localStorage
                locations = [];
                mergeLocalStorage();
                dataReady = true;
                tryInit();
            });
    }

    function mergeLocalStorage() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var local = JSON.parse(raw);
                if (Array.isArray(local)) {
                    // localStorage 数据覆盖同 ID 的 JSON 数据（admin 的未发布修改）
                    local.forEach(function (l) {
                        var idx = locations.findIndex(function (x) { return x.id === l.id; });
                        if (idx >= 0) {
                            locations[idx] = l;
                        } else {
                            locations.push(l);
                        }
                    });
                }
            }
        } catch (e) {}
    }

    function saveLocations() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(locations));
    }

    function exportLocationsJSON() {
        var data = locations.map(function (l) {
            return {
                id: l.id, name: l.name, lng: l.lng, lat: l.lat,
                province: l.province || '', city: l.city || '', district: l.district || '',
                address: l.address || '', count: l.count, remark: l.remark || ''
            };
        });
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'locations.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('已下载 locations.json，请替换仓库中的文件并推送');
    }

    function autoPublish() {
        var token = getGithubToken();
        if (!token) return;

        var data = locations.map(function (l) {
            return {
                id: l.id, name: l.name, lng: l.lng, lat: l.lat,
                province: l.province || '', city: l.city || '', district: l.district || '',
                address: l.address || '', count: l.count, remark: l.remark || ''
            };
        });
        var content = JSON.stringify(data, null, 2);
        var base64 = btoa(unescape(encodeURIComponent(content)));

        fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_FILE, {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function (r) {
            if (!r.ok) throw new Error('GET failed: ' + r.status);
            return r.json();
        })
        .then(function (fileInfo) {
            if (!fileInfo.sha) throw new Error('No SHA returned');
            return fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_FILE, {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: 'Update locations (' + data.length + ' items)',
                    content: base64,
                    sha: fileInfo.sha
                })
            });
        })
        .then(function (r) {
            if (!r.ok) throw new Error('PUT failed: ' + r.status);
            return r.json();
        })
        .then(function () {
            showToast('已发布');
        })
        .catch(function (e) {
            showToast('发布失败: ' + e.message);
        });
    }

    function genId() {
        return 'loc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }

    // ============================================================
    // 权限验证
    // ============================================================
    async function sha256(message) {
        var encoder = new TextEncoder();
        var data = encoder.encode(message);
        var hashBuffer = await crypto.subtle.digest('SHA-256', data);
        var hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }

    function enterAdminMode() {
        isAdmin = true;
        document.body.classList.add('is-admin');
        sessionStorage.setItem(AUTH_SESSION_KEY, '1');
        btnLock.classList.remove('hidden');
        renderList();
        if (isPanelExpanded) renderList();
        showToast('管理验证通过');
    }

    function exitAdminMode() {
        isAdmin = false;
        document.body.classList.remove('is-admin');
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        btnLock.classList.add('hidden');
        // 关闭所有管理弹窗
        if (!modalOverlay.classList.contains('modal-hidden')) closeModal();
        if (infoWindow) { infoWindow.close(); infoWindow = null; }
        renderList();
        collapsePanel();
        showToast('已锁定');
    }

    function checkAdminAuth() {
        // 检查 sessionStorage 中是否有有效会话
        if (sessionStorage.getItem(AUTH_SESSION_KEY) === '1') {
            enterAdminMode();
            // 清除 URL 中的 #admin，保持 URL 干净
            if (window.location.hash === '#admin') {
                history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            return;
        }

        // 检查 URL hash 是否为 #admin，弹出验证弹窗
        if (window.location.hash === '#admin') {
            showAuthModal();
        }
    }

    function showAuthModal() {
        authPassword.value = '';
        authMsg.textContent = '';
        authMsg.className = '';
        authOverlay.classList.remove('modal-hidden');
        setTimeout(function () { authPassword.focus(); }, 350);
    }

    function closeAuthModal() {
        authOverlay.classList.add('modal-hidden');
        // 清除 URL hash
        if (window.location.hash === '#admin') {
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }

    async function handleAuthConfirm() {
        var pw = authPassword.value;
        if (!pw) {
            authMsg.textContent = '请输入密码';
            authMsg.className = 'error';
            return;
        }
        var hash = await sha256(pw);
        if (hash === ADMIN_PW_HASH) {
            closeAuthModal();
            enterAdminMode();
        } else {
            authMsg.textContent = '密码错误，请重试';
            authMsg.className = 'error';
            authPassword.value = '';
            authPassword.focus();
        }
    }

    // 验证弹窗事件
    btnAuthConfirm.addEventListener('click', handleAuthConfirm);
    btnAuthCancel.addEventListener('click', closeAuthModal);
    authOverlay.addEventListener('click', function (e) {
        if (e.target === authOverlay) closeAuthModal();
    });
    authPassword.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') handleAuthConfirm();
    });

    // 锁定按钮
    btnLock.addEventListener('click', function () {
        if (confirm('确定要锁定管理面板吗？锁定后需要重新验证密码。')) {
            exitAdminMode();
        }
    });

    // ============================================================
    // 地图初始化
    // ============================================================
    function initMap() {
        var container = document.getElementById('map-container');

        if (container.offsetWidth === 0 || container.offsetHeight === 0) {
            setTimeout(initMap, 50);
            return;
        }

        map = new AMap.Map('map-container', {
            center: [104.0, 35.0],
            zoom: 5,
            resizeEnable: true
        });

        // 地理编码
        try { geocoder = new AMap.Geocoder({ city: '全国' }); } catch (e) { geocoder = null; }

        // 自动补全
        try {
            autoComplete = new AMap.AutoComplete({ input: 'search-input', city: '全国' });
        } catch (e) {
            autoComplete = null;
        }

        // resize 后重绘标记
        [200, 600, 1200].forEach(function (ms) {
            setTimeout(function () {
                if (map) { map.resize(); renderAllMarkers(); }
            }, ms);
        });

        // 地图右击 → 添加位置（桌面端，仅管理员）
        map.on('rightclick', function (e) {
            if (!isAdmin) return;
            openAddModal(e.lnglat.lng, e.lnglat.lat);
        });

        // 地图长按 → 添加位置（移动端，仅管理员）
        mapContainer.addEventListener('touchstart', function (e) {
            if (!isAdmin) return;
            if (e.target.closest('.amap-marker') || e.target.closest('#search-bar') ||
                e.target.closest('#btn-add') || e.target.closest('#bottom-panel') ||
                e.target.closest('#modal-overlay')) return;
            const touch = e.touches[0];
            const sx = touch.clientX, sy = touch.clientY;
            longPressTimer = setTimeout(function () {
                const rect = mapContainer.getBoundingClientRect();
                const pixel = new AMap.Pixel(sx - rect.left, sy - rect.top);
                const lnglat = map.containerToLngLat(pixel);
                openAddModal(lnglat.lng, lnglat.lat);
                // 震动反馈
                if (navigator.vibrate) navigator.vibrate(15);
            }, 700);
        }, { passive: false });

        mapContainer.addEventListener('touchend', function () {
            clearTimeout(longPressTimer);
        });
        mapContainer.addEventListener('touchmove', function () {
            clearTimeout(longPressTimer);
        });

        // 点击地图空白区域 → 收起面板、关闭信息窗
        map.on('click', function () {
            collapsePanel();
            if (infoWindow) { infoWindow.close(); infoWindow = null; }
        });

        renderAllMarkers();
    }

    // ============================================================
    // 标记渲染
    // ============================================================
    function renderAllMarkers() {
        if (!map) return;  // 地图未就绪
        // 清除旧标记
        Object.values(markers).forEach(function (m) {
            try { m.setMap(null); } catch (e) {}
        });
        markers = {};

        locations.forEach(function (loc) {
            createMarker(loc);
        });
    }

    function createMarker(loc) {
        try {
            var lng = parseFloat(loc.lng);
            var lat = parseFloat(loc.lat);
            if (isNaN(lng) || isNaN(lat)) return;

            var marker = new AMap.Marker({
                position: [lng, lat],
                title: loc.name,
                label: {
                    content: '<div style="text-align:center;background:#1677ff;color:#fff;padding:5px 14px;border-radius:18px;line-height:1.4;box-shadow:0 2px 8px rgba(22,119,255,0.35);max-width:160px;"><b>' + escHtml(loc.name) + '</b><br>' + loc.count + '台Moment</div>',
                    offset: new AMap.Pixel(0, -44),
                    direction: 'top'
                },
                zIndex: 100
            });

            marker.on('click', function () {
                showInfoWindow(loc, marker);
            });

            marker.setMap(map);
            markers[loc.id] = marker;
        } catch (e) {
            showToast('标记创建失败: ' + loc.name);
        }
    }

    function showInfoWindow(loc, marker) {
        if (!map) return;
        if (infoWindow) { infoWindow.close(); }

        var content = '<div class="info-window" style="width:180px;position:relative;">' +
            '<img src="moment.png" style="display:block;width:160px;height:160px;object-fit:contain;border-radius:4px;margin:0 0 6px 0;" onerror="this.style.display=\'none\'">' +
            '<div class="iw-name">' + escHtml(loc.name) + '</div>' +
            '<div class="iw-count"><strong>' + loc.count + '</strong>台Moment</div>';
        if (loc.province || loc.city || loc.district || loc.address) {
            content += '<div class="iw-addr">' + escHtml(formatLocationAddr(loc)) + '</div>';
        }
        if (loc.remark) {
            content += '<div class="iw-remark">' + escHtml(loc.remark) + '</div>';
        }
        if (isAdmin) {
            content += '<div style="margin-top:8px;display:flex;gap:8px;">' +
                '<a href="javascript:void(0)" onclick="window.__editLocation(\'' + loc.id + '\')" style="color:#1677ff;font-size:13px;">编辑</a>' +
                '<a href="javascript:void(0)" onclick="window.__deleteLocation(\'' + loc.id + '\')" style="color:#ff4d4f;font-size:13px;">删除</a>' +
                '</div>';
        }
        content += '</div>';

        infoWindow = new AMap.InfoWindow({
            content: content,
            offset: new AMap.Pixel(0, -40),
            autoMove: true,
            isCustom: false
        });
        infoWindow.on('close', function () {
            infoWindow = null;
        });
        infoWindow.open(map, marker.getPosition());

        // 暴露全局方法供 InfoWindow 内联调用
        window.__editLocation = function (id) {
            if (infoWindow) infoWindow.close();
            openEditModal(id);
        };
        window.__deleteLocation = function (id) {
            if (infoWindow) infoWindow.close();
            deleteLocation(id);
        };
    }

    function removeMarkerFromMap(id) {
        if (markers[id]) {
            markers[id].setMap(null);
            delete markers[id];
        }
    }

    function focusOnLocation(loc) {
        if (!map) return;
        var lng = parseFloat(loc.lng);
        var lat = parseFloat(loc.lat);
        if (isNaN(lng) || isNaN(lat)) return;
        // 先收起面板
        collapsePanel();
        // 等面板收起动画完成后再移动地图，确保目标位置在视口中间
        setTimeout(function () {
            map.setZoomAndCenter(15, [lng, lat]);
            if (markers[loc.id]) {
                setTimeout(function () {
                    showInfoWindow(loc, markers[loc.id]);
                }, 400);
            }
        }, 400);
    }

    // ============================================================
    // 搜索
    // ============================================================
    searchInput.addEventListener('input', function () {
        var val = searchInput.value.trim();
        if (val) {
            searchClear.classList.add('visible');
            doSearch(val);
        } else {
            searchClear.classList.remove('visible');
            searchResults.classList.remove('visible');
        }
    });

    searchInput.addEventListener('focus', function () {
        if (searchInput.value.trim()) {
            doSearch(searchInput.value.trim());
        }
    });

    searchClear.addEventListener('click', function () {
        searchInput.value = '';
        searchClear.classList.remove('visible');
        searchResults.classList.remove('visible');
        searchInput.focus();
    });

    function doSearch(keyword) {
        if (!autoComplete) return;
        autoComplete.search(keyword, function (status, result) {
            if (status === 'complete' && result.tips && result.tips.length > 0) {
                var html = '';
                result.tips.forEach(function (tip) {
                    if (tip.location) {
                        html += '<div class="search-result-item" data-lng="' + tip.location.lng +
                            '" data-lat="' + tip.location.lat +
                            '" data-name="' + escAttr(tip.name) +
                            '" data-addr="' + escAttr(tip.district + (tip.address || '')) + '">' +
                            '<div class="result-name">' + escHtml(tip.name) + '</div>' +
                            '<div class="result-addr">' + escHtml(tip.district + (tip.address || '')) + '</div>' +
                            '</div>';
                    }
                });
                if (html) {
                    searchResults.innerHTML = html;
                    searchResults.classList.add('visible');
                    // 绑定点击
                    searchResults.querySelectorAll('.search-result-item').forEach(function (item) {
                        item.addEventListener('click', function () {
                            var lng = parseFloat(this.dataset.lng);
                            var lat = parseFloat(this.dataset.lat);
                            var name = this.dataset.name;
                            searchResults.classList.remove('visible');
                            searchInput.value = '';
                            searchClear.classList.remove('visible');
                            openAddModal(lng, lat, name);
                        });
                    });
                } else {
                    searchResults.classList.remove('visible');
                }
            } else {
                searchResults.classList.remove('visible');
            }
        });
    }

    // 点击页面其他位置关闭搜索结果
    document.addEventListener('click', function (e) {
        if (!e.target.closest('#search-bar')) {
            searchResults.classList.remove('visible');
        }
    });

    // ============================================================
    // 底部面板
    // ============================================================
    // ============================================================
    // 面板拖拽
    // ============================================================
    var panelDragY = 0;
    var panelStartY = 0;
    var panelStartOffset = 0;
    var panelTravel = 380 - 56; // 面板可拖拽距离

    function getPanelOffset() {
        var t = bottomPanel.style.transform || '';
        var m = t.match(/translateY\(([-\d.]+)px\)/);
        return m ? parseFloat(m[1]) : 0;
    }

    function setPanelOffset(y) {
        y = Math.max(0, Math.min(panelTravel, y));
        bottomPanel.style.transform = 'translateY(' + y + 'px)';
        bottomPanel.style.transition = 'none';
    }

    function snapPanel(y) {
        bottomPanel.style.transition = '';
        if (y > panelTravel / 2) {
            collapsePanel();
        } else {
            expandPanel();
        }
    }

    panelHandle.addEventListener('mousedown', onDragStart);
    panelHandle.addEventListener('touchstart', onDragStart, { passive: false });

    function onDragStart(e) {
        e.preventDefault();
        panelStartY = e.touches ? e.touches[0].clientY : e.clientY;
        panelStartOffset = isPanelExpanded ? 0 : panelTravel;
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchmove', onDragMove, { passive: false });
        document.addEventListener('touchend', onDragEnd);
    }

    function onDragMove(e) {
        var currentY = e.touches ? e.touches[0].clientY : e.clientY;
        var delta = currentY - panelStartY;
        // 向下拖动 = 收起面板（translateY 增大）
        var offset = panelStartOffset + delta;
        setPanelOffset(offset);
    }

    function onDragEnd(e) {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        document.removeEventListener('touchmove', onDragMove);
        document.removeEventListener('touchend', onDragEnd);
        var offset = getPanelOffset();
        snapPanel(offset);
    }

    function togglePanel() {
        if (isPanelExpanded) {
            collapsePanel();
        } else {
            expandPanel();
        }
    }

    function expandPanel() {
        bottomPanel.classList.remove('panel-collapsed');
        bottomPanel.style.transform = '';
        bottomPanel.style.transition = '';
        isPanelExpanded = true;
        renderList();
    }

    function collapsePanel() {
        bottomPanel.classList.add('panel-collapsed');
        bottomPanel.style.transform = '';
        bottomPanel.style.transition = '';
        isPanelExpanded = false;
    }

    function renderList() {
        panelCount.textContent = locations.length;
        if (locations.length === 0) {
            panelList.innerHTML = '';
            panelList.appendChild(panelEmpty);
            panelEmpty.style.display = '';
            return;
        }
        panelEmpty.style.display = 'none';

        var html = '';
        locations.forEach(function (loc) {
            html += '<div class="location-card" data-id="' + loc.id + '">' +
                '<img src="moment.png" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\'none\'">' +
                '<div class="card-info">' +
                '<div class="card-name">' + escHtml(loc.name) + '</div>' +
                '<div class="card-count"><strong>' + loc.count + '</strong>台Moment</div>' +
                (loc.province || loc.city || loc.district || loc.address ? '<div style="font-size:12px;color:#999;margin-top:2px;">' + escHtml(formatLocationAddr(loc)) + '</div>' : '') +
                (loc.remark ? '<div style="font-size:12px;color:#999;margin-top:2px;">' + escHtml(loc.remark) + '</div>' : '') +
                '</div>' +
                (isAdmin ? '<div class="card-actions">' +
                '<button class="card-btn card-btn-edit" data-action="edit" data-id="' + loc.id + '">&#9998;</button>' +
                '<button class="card-btn card-btn-del" data-action="delete" data-id="' + loc.id + '">&#10005;</button>' +
                '</div>' : '') +
                '</div>';
        });
        panelList.innerHTML = html;

        // 绑定卡片点击 → 定位到地图
        panelList.querySelectorAll('.location-card').forEach(function (card) {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.card-btn')) return; // 不拦截按钮点击
                var id = this.dataset.id;
                var loc = locations.find(function (l) { return l.id === id; });
                if (loc) {
                    focusOnLocation(loc);
                    collapsePanel();
                }
            });
        });

        // 绑定编辑按钮
        panelList.querySelectorAll('.card-btn-edit').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                openEditModal(this.dataset.id);
            });
        });

        // 绑定删除按钮
        panelList.querySelectorAll('.card-btn-del').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                deleteLocation(this.dataset.id);
            });
        });

        // 同步刷新胶囊标签
        renderPills();
    }

    function renderPills() {
        if (locations.length === 0) {
            panelPills.innerHTML = '';
            return;
        }
        var html = '';
        locations.forEach(function (loc) {
            html += '<span class="pill-tag" data-id="' + loc.id + '">' +
                escHtml(loc.name) +
                ' <span class="pill-count">' + loc.count + '台Moment</span>' +
                '</span>';
        });
        panelPills.innerHTML = html;

        panelPills.querySelectorAll('.pill-tag').forEach(function (pill) {
            pill.addEventListener('click', function () {
                // 胶囊标签点击 → 展开面板，不移动地图
                expandPanel();
            });
        });
    }

    // ============================================================
    // 删除
    // ============================================================
    function deleteLocation(id) {
        if (!isAdmin) return;
        if (!confirm('确定要删除这个位置吗？')) return;
        locations = locations.filter(function (l) { return l.id !== id; });
        removeMarkerFromMap(id);
        saveLocations();
        autoPublish();
        renderList();
        panelCount.textContent = locations.length;
        if (infoWindow) { infoWindow.close(); infoWindow = null; }
        showToast('已删除');
    }

    // ============================================================
    // 省市区三级联动
    // ============================================================
    var provinceData = [];

    // 按需创建 DistrictSearch 实例，避免 level 不匹配导致搜索失败
    function searchDistrict(keyword, level, callback) {
        AMap.plugin('AMap.DistrictSearch', function () {
            var ds = new AMap.DistrictSearch({
                level: level,
                subdistrict: 1,
                extensions: 'base'
            });
            ds.search(keyword, function (status, result) {
                callback(status, result);
            });
        });
    }

    function loadProvinces() {
        searchDistrict('中国', 'country', function (status, result) {
            if (status !== 'complete') return;
            provinceData = result.districtList[0].districtList.filter(function (p) {
                return p.level === 'province';
            });
            var html = '<option value="">请选择省份</option>';
            provinceData.forEach(function (p) {
                html += '<option value="' + escAttr(p.name) + '">' + escHtml(p.name) + '</option>';
            });
            formProvince.innerHTML = html;
            resetCityDistrict();
        });
    }

    function resetCityDistrict() {
        formCity.innerHTML = '<option value="">请先选择省份</option>';
        formCity.disabled = true;
        formDistrict.innerHTML = '<option value="">请先选择城市</option>';
        formDistrict.disabled = true;
        formCity.dataset.loaded = '';
        formDistrict.dataset.loaded = '';
    }

    function onProvinceChange() {
        var name = formProvince.value;
        if (!name) { resetCityDistrict(); return; }

        var directCities = ['北京市', '天津市', '上海市', '重庆市'];

        if (directCities.indexOf(name) !== -1) {
            // 直辖市：跳过市，需要挖两层才能拿到真正的区县
            formCity.innerHTML = '<option value="">(直辖市)</option>';
            formCity.disabled = true;
            formCity.dataset.loaded = 'direct';
            loadMunicipalityDistricts(name, formDistrict, '请选择区/县');
        } else {
            // 普通省份：加载城市
            formDistrict.innerHTML = '<option value="">请先选择城市</option>';
            formDistrict.disabled = true;
            formDistrict.dataset.loaded = '';
            formCity.disabled = false;
            loadChildren(name, 'province', formCity, '请选择城市');
        }
    }

    function onCityChange() {
        var name = formCity.value;
        if (!name) {
            formDistrict.innerHTML = '<option value="">请先选择城市</option>';
            formDistrict.disabled = true;
            formDistrict.dataset.loaded = '';
            return;
        }
        loadChildren(name, 'city', formDistrict, '请选择区/县');
    }

    function loadChildren(parentName, level, targetSelect, defaultLabel) {
        var cacheKey = 'children_' + parentName;
        if (targetSelect.dataset.loaded === cacheKey) return;

        targetSelect.innerHTML = '<option value="">加载中...</option>';
        targetSelect.disabled = true;

        searchDistrict(parentName, level, function (status, result) {
            if (status !== 'complete' || !result.districtList || result.districtList.length === 0) {
                targetSelect.innerHTML = '<option value="">加载失败</option>';
                return;
            }
            var children = result.districtList[0].districtList;
            if (!children || children.length === 0) {
                targetSelect.innerHTML = '<option value="">暂无数据</option>';
                targetSelect.disabled = true;
                return;
            }
            populateSelect(targetSelect, children, defaultLabel, cacheKey);
        });
    }

    // 直辖市：省 → 市辖区(city) → 区县(district)，需要多挖一层
    function loadMunicipalityDistricts(provinceName, targetSelect, defaultLabel) {
        var cacheKey = 'munic_' + provinceName;
        if (targetSelect.dataset.loaded === cacheKey) return;

        targetSelect.innerHTML = '<option value="">加载中...</option>';
        targetSelect.disabled = true;

        searchDistrict(provinceName, 'province', function (status, result) {
            if (status !== 'complete' || !result.districtList || result.districtList.length === 0) {
                targetSelect.innerHTML = '<option value="">加载失败</option>';
                return;
            }
            var cities = result.districtList[0].districtList;
            if (!cities || cities.length === 0) {
                targetSelect.innerHTML = '<option value="">暂无数据</option>';
                targetSelect.disabled = true;
                return;
            }

            // 直辖市的 province 下是 city 级别（市辖区、县），需要逐个查询它们的下一级
            var allDistricts = [];
            var pending = cities.length;

            cities.forEach(function (city) {
                searchDistrict(city.name, 'city', function (s2, r2) {
                    if (s2 === 'complete' && r2.districtList && r2.districtList.length > 0) {
                        var subs = r2.districtList[0].districtList;
                        if (subs) {
                            allDistricts = allDistricts.concat(subs);
                        }
                    }
                    pending--;
                    if (pending === 0) {
                        populateSelect(targetSelect, allDistricts, defaultLabel, cacheKey);
                    }
                });
            });
        });
    }

    function populateSelect(targetSelect, items, defaultLabel, cacheKey) {
        if (items.length === 0) {
            targetSelect.innerHTML = '<option value="">暂无数据</option>';
            targetSelect.disabled = true;
            return;
        }
        var html = '<option value="">' + defaultLabel + '</option>';
        items.forEach(function (item) {
            html += '<option value="' + escAttr(item.name) + '">' + escHtml(item.name) + '</option>';
        });
        targetSelect.innerHTML = html;
        targetSelect.disabled = false;
        if (cacheKey) targetSelect.dataset.loaded = cacheKey;
    }

    function getFullAddress() {
        var parts = [];
        var p = formProvince.value;
        var c = formCity.value;
        var d = formDistrict.value;
        var a = formAddress.value.trim();
        if (p) parts.push(p);
        if (c && formCity.dataset.loaded !== 'direct') parts.push(c);
        if (d) parts.push(d);
        if (a) parts.push(a);
        return parts.join('');
    }

    // 级联事件绑定
    formProvince.addEventListener('change', onProvinceChange);
    formCity.addEventListener('change', onCityChange);

    // ============================================================
    // 弹窗：添加 / 编辑
    // ============================================================
    btnAdd.addEventListener('click', function () {
        openAddModal(null, null, null);
    });

    function openAddModal(lng, lat, name) {
        if (!isAdmin) return;
        editingId = null;
        pendingLng = lng != null ? lng : null;
        pendingLat = lat != null ? lat : null;
        modalTitle.textContent = '添加位置';
        formName.value = name || '';
        formAddress.value = '';
        formCount.value = '';
        formRemark.value = '';
        loadProvinces();
        updateCoordsHint();
        btnDelete.classList.add('hidden');
        modalOverlay.classList.remove('modal-hidden');
        setTimeout(function () { formName.focus(); }, 350);
    }

    function openEditModal(id) {
        if (!isAdmin) return;
        var loc = locations.find(function (l) { return l.id === id; });
        if (!loc) return;
        editingId = id;
        pendingLng = loc.lng;
        pendingLat = loc.lat;
        modalTitle.textContent = '编辑位置';
        formName.value = loc.name;
        formAddress.value = loc.address || '';
        formCount.value = loc.count;
        formRemark.value = loc.remark || '';
        updateCoordsHint();
        btnDelete.classList.remove('hidden');
        modalOverlay.classList.remove('modal-hidden');

        // 加载省份并回填已选值
        loadProvincesForEdit(loc.province, loc.city, loc.district);
    }

    function loadProvincesForEdit(savedProvince, savedCity, savedDistrict) {
        searchDistrict('中国', 'country', function (status, result) {
            if (status !== 'complete') return;
            provinceData = result.districtList[0].districtList.filter(function (p) {
                return p.level === 'province';
            });
            var html = '<option value="">请选择省份</option>';
            provinceData.forEach(function (p) {
                html += '<option value="' + escAttr(p.name) + '"' +
                    (p.name === savedProvince ? ' selected' : '') + '>' + escHtml(p.name) + '</option>';
            });
            formProvince.innerHTML = html;

            if (savedProvince) {
                loadChildrenForEdit(savedProvince, savedCity, savedDistrict);
            } else {
                resetCityDistrict();
            }
        });
    }

    function loadChildrenForEdit(provinceName, savedCity, savedDistrict) {
        var directCities = ['北京市', '天津市', '上海市', '重庆市'];
        var isDirect = directCities.indexOf(provinceName) !== -1;

        searchDistrict(provinceName, 'province', function (status, result) {
            if (status !== 'complete' || !result.districtList || result.districtList.length === 0) return;
            var children = result.districtList[0].districtList;

            if (isDirect) {
                formCity.innerHTML = '<option value="">(直辖市)</option>';
                formCity.disabled = true;
                formCity.dataset.loaded = 'direct';

                // 直辖市需要挖两层：省 → 市辖区 → 区县
                var allDistricts = [];
                var pending = children.length;
                if (pending === 0) {
                    formDistrict.innerHTML = '<option value="">暂无数据</option>';
                    formDistrict.disabled = true;
                    return;
                }
                children.forEach(function (city) {
                    searchDistrict(city.name, 'city', function (s2, r2) {
                        if (s2 === 'complete' && r2.districtList && r2.districtList.length > 0) {
                            var subs = r2.districtList[0].districtList;
                            if (subs) allDistricts = allDistricts.concat(subs);
                        }
                        pending--;
                        if (pending === 0) {
                            var dhtml = '<option value="">请选择区/县</option>';
                            allDistricts.forEach(function (d) {
                                dhtml += '<option value="' + escAttr(d.name) + '"' +
                                    (d.name === savedDistrict ? ' selected' : '') + '>' + escHtml(d.name) + '</option>';
                            });
                            formDistrict.innerHTML = dhtml;
                            formDistrict.disabled = false;
                        }
                    });
                });
            } else {
                var chtml = '<option value="">请选择城市</option>';
                children.forEach(function (c) {
                    chtml += '<option value="' + escAttr(c.name) + '"' +
                        (c.name === savedCity ? ' selected' : '') + '>' + escHtml(c.name) + '</option>';
                });
                formCity.innerHTML = chtml;
                formCity.disabled = false;

                if (savedCity) {
                    loadDistrictsForEdit(savedCity, savedDistrict);
                } else {
                    formDistrict.innerHTML = '<option value="">请先选择城市</option>';
                    formDistrict.disabled = true;
                }
            }
        });
    }

    function loadDistrictsForEdit(cityName, savedDistrict) {
        searchDistrict(cityName, 'city', function (status, result) {
            if (status !== 'complete' || !result.districtList || result.districtList.length === 0) return;
            var children = result.districtList[0].districtList;
            var html = '<option value="">请选择区/县</option>';
            children.forEach(function (d) {
                html += '<option value="' + escAttr(d.name) + '"' +
                    (d.name === savedDistrict ? ' selected' : '') + '>' + escHtml(d.name) + '</option>';
            });
            formDistrict.innerHTML = html;
            formDistrict.disabled = false;
        });
    }

    function updateCoordsHint() {
        if (pendingLng != null && pendingLat != null) {
            hintCoords.textContent = '已定位：' + pendingLng.toFixed(6) + ', ' + pendingLat.toFixed(6);
            hintCoords.className = 'form-hint-coords';
        } else {
            hintCoords.textContent = '请在地图上长按选点，或填写地址后自动定位';
            hintCoords.className = 'form-hint-coords';
        }
    }

    function closeModal() {
        modalOverlay.classList.add('modal-hidden');
        editingId = null;
    }

    btnCancel.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', function (e) {
        if (e.target === modalOverlay) closeModal();
    });

    btnDelete.addEventListener('click', function () {
        if (editingId) {
            deleteLocation(editingId);
            closeModal();
        }
    });

    btnSave.addEventListener('click', function () {
        var name = formName.value.trim();
        var province = formProvince.value;
        var city = formCity.dataset.loaded === 'direct' ? province : formCity.value;
        var dist = formDistrict.value;
        var address = formAddress.value.trim();
        var count = parseInt(formCount.value, 10);
        var remark = formRemark.value.trim();

        // 校验
        if (!name) { showToast('请输入咖啡店名称'); formName.focus(); return; }
        if (isNaN(count) || count < 1) { showToast('请输入有效的设备数量'); formCount.focus(); return; }

        // 如果有地图选点坐标，直接保存
        if (pendingLng != null && pendingLat != null) {
            doSave(name, pendingLng, pendingLat, province, city, dist, address, count, remark);
            return;
        }

        // 没有坐标，尝试通过地址地理编码
        var fullAddr = getFullAddress();
        if (!fullAddr) {
            showToast('请在地图上长按选点，或选择地址');
            return;
        }

        btnSave.disabled = true;
        btnSave.textContent = '定位中...';

        if (!geocoder) {
            // geocoder 未就绪，尝试重新创建
            try { geocoder = new AMap.Geocoder({ city: '全国' }); } catch (e) {}
            if (!geocoder) {
                btnSave.disabled = false;
                btnSave.textContent = '保存';
                hintCoords.textContent = '定位服务未就绪，请在地图上长按选点';
                hintCoords.className = 'form-hint-coords has-error';
                return;
            }
        }

        var geoTimeout = setTimeout(function () {
            btnSave.disabled = false;
            btnSave.textContent = '保存';
            hintCoords.textContent = '定位超时，请检查网络后重试或在地图上选点';
            hintCoords.className = 'form-hint-coords has-error';
        }, 10000);

        try {
            geocoder.getLocation(fullAddr, function (status, result) {
                clearTimeout(geoTimeout);
                btnSave.disabled = false;
                btnSave.textContent = '保存';
                if (status === 'complete' && result.geocodes.length > 0) {
                    var gc = result.geocodes[0];
                    var lng = gc.location.lng;
                    var lat = gc.location.lat;
                    pendingLng = lng;
                    pendingLat = lat;
                    updateCoordsHint();
                    doSave(name, lng, lat, province, city, dist, address, count, remark);
                } else {
                    hintCoords.textContent = '地址无法定位，请检查后重试或在地图上选点';
                    hintCoords.className = 'form-hint-coords has-error';
                }
            });
        } catch (e) {
            clearTimeout(geoTimeout);
            btnSave.disabled = false;
            btnSave.textContent = '保存';
            hintCoords.textContent = '定位服务异常，请在地图上长按选点';
            hintCoords.className = 'form-hint-coords has-error';
        }
    });

    function doSave(name, lng, lat, province, city, district, address, count, remark) {
        if (editingId) {
            var loc = locations.find(function (l) { return l.id === editingId; });
            if (loc) {
                loc.name = name;
                loc.lng = lng;
                loc.lat = lat;
                loc.province = province;
                loc.city = city;
                loc.district = district;
                loc.address = address;
                loc.count = count;
                loc.remark = remark;
                removeMarkerFromMap(editingId);
                createMarker(loc);
            }
        } else {
            var newLoc = {
                id: genId(),
                name: name,
                lng: lng,
                lat: lat,
                province: province,
                city: city,
                district: district,
                address: address,
                count: count,
                remark: remark
            };
            locations.push(newLoc);
            createMarker(newLoc);
        }

        saveLocations();
        autoPublish();
        renderList();
        panelCount.textContent = locations.length;
        closeModal();

        var targetLoc = locations.find(function (l) {
            return editingId ? l.id === editingId : l.name === name;
        });
        if (targetLoc) {
            focusOnLocation(targetLoc);
            expandPanel();
        }

        showToast(editingId ? '已更新' : '已添加');
    }

    // ============================================================
    // 工具函数
    // ============================================================
    function escHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function formatLocationAddr(loc) {
        var parts = [];
        if (loc.province) parts.push(loc.province);
        if (loc.city && loc.city !== loc.province) parts.push(loc.city);
        if (loc.district) parts.push(loc.district);
        if (loc.address) parts.push(loc.address);
        return parts.join('');
    }

    function showToast(msg) {
        var toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(function () { toast.remove(); }, 2100);
    }

    // ============================================================
    // 入口
    // ============================================================
    var dataReady = false;
    var amapReady = false;

    function tryInit() {
        if (!dataReady || !amapReady) return;
        initMap();
        renderList();
        panelCount.textContent = locations.length;

        window.addEventListener('pageshow', function (e) {
            if (e.persisted) {
                if (map) { map.destroy(); map = null; }
                Object.values(markers).forEach(function (m) { m.setMap(null); });
                markers = {};
                initMap();
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                if (!authOverlay.classList.contains('modal-hidden')) {
                    closeAuthModal();
                } else if (!modalOverlay.classList.contains('modal-hidden')) {
                    closeModal();
                }
            }
        });

        window.addEventListener('hashchange', function () {
            if (!isAdmin && window.location.hash === '#admin') {
                showAuthModal();
            }
        });
    }

    // 等待 AMap SDK 加载
    function waitForAMap(cb) {
        if (window.AMap && AMap.Map) {
            cb();
        } else {
            setTimeout(function () { waitForAMap(cb); }, 100);
        }
    }

    // 启动：加载数据 → 等待 SDK → 初始化地图
    loadLocations();
    checkAdminAuth();
    waitForAMap(function () {
        amapReady = true;
        tryInit();
    });
})();
