import { ChevronDown } from "lucide-react";

interface CollapseChevronProps {
    collapsed: boolean;
    size?: number;
}

/**
 * 分组折叠箭头:固定使用向下的 Chevron 图标,
 * 通过 CSS transform 旋转实现展开/收起的平滑过渡,
 * 替代原先 ChevronRight / ChevronDown 两个图标的瞬时切换。
 */
export function CollapseChevron({ collapsed, size = 16 }: CollapseChevronProps) {
    return (
        <ChevronDown
            size={size}
            className={`collapse-chevron${collapsed ? " collapsed" : ""}`}
        />
    );
}
