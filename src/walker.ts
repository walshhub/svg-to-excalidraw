import { mat4 } from "gl-matrix";
import { dimensionsFromPoints } from "./utils";
import ExcalidrawScene from "./elements/ExcalidrawScene";
import Group, { getGroupAttrs } from "./elements/Group";
import {
  ExcalidrawElementBase,
  ExcalidrawRectangle,
  ExcalidrawEllipse,
  ExcalidrawLine,
  ExcalidrawDraw,
  ExcalidrawText,
  createExRect,
  createExEllipse,
  createExLine,
  createExDraw,
  createExText,
  Point,
} from "./elements/ExcalidrawElement";
import {
  presAttrsToElementValues,
  filterAttrsToElementValues,
  pointsAttrToPoints,
  has,
  get,
  getNum,
} from "./attributes";
import { getTransformMatrix, transformPoints } from "./transform";
import { pointsOnPath } from "points-on-path";
import { randomId, getWindingOrder } from "./utils";

const SUPPORTED_TAGS = [
  "svg",
  "path",
  "g",
  "text",
  "use",
  "circle",
  "ellipse",
  "rect",
  "polyline",
  "polygon",
];

const nodeValidator = (node: Element): number => {
  if (SUPPORTED_TAGS.includes(node.tagName)) {
    return NodeFilter.FILTER_ACCEPT;
  }

  return NodeFilter.FILTER_REJECT;
};

export function createTreeWalker(dom: Node): TreeWalker {
  return document.createTreeWalker(dom, NodeFilter.SHOW_ALL, {
    acceptNode: nodeValidator,
  });
}

type WalkerArgs = {
  root: Document;
  tw: TreeWalker;
  scene: ExcalidrawScene;
  groups: Group[];
};

const presAttrs = (
  el: Element,
  groups: Group[],
): Partial<ExcalidrawElementBase> => {
  return {
    ...getGroupAttrs(groups),
    ...presAttrsToElementValues(el),
    ...filterAttrsToElementValues(el),
  };
};

const skippedUseAttrs = ["id"];
const allwaysPassedUseAttrs = [
  "x",
  "y",
  "width",
  "height",
  "href",
  "xlink:href",
];

/*
  "Most attributes on use do not override those already on the element
  referenced by use. (This differs from how CSS style attributes override
  those set 'earlier' in the cascade). Only the attributes x, y, width,
  height and href on the use element will override those set on the
  referenced element. However, any other attributes not set on the referenced
  element will be applied to the use element."

  Situation 1: Attr is set on defEl, NOT on useEl
    - result: use defEl attr
  Situation 2: Attr is on useEl, NOT on defEl
    - result: use the useEl attr
  Situation 3: Attr is on both useEl and defEl
    - result: use the defEl attr (Unless x, y, width, height, href, xlink:href)
*/
const getDefElWithCorrectAttrs = (defEl: Element, useEl: Element): Element => {
  const finalEl = [...useEl.attributes].reduce((el, attr) => {
    if (skippedUseAttrs.includes(attr.value)) {
      return el;
    }

    // Does defEl have the attr? If so, use it, else use the useEl attr
    if (
      !defEl.hasAttribute(attr.name) ||
      allwaysPassedUseAttrs.includes(attr.name)
    ) {
      el.setAttribute(attr.name, useEl.getAttribute(attr.name) || "");
    }
    return el;
  }, defEl.cloneNode() as Element);

  return finalEl;
};

const walkers = {
  svg: (args: WalkerArgs) => {
    walk(args, args.tw.nextNode());
  },

  g: (args: WalkerArgs) => {
    const nextArgs = {
      ...args,
      tw: createTreeWalker(args.tw.currentNode),
      groups: [...args.groups, new Group(args.tw.currentNode as Element)],
    };

    walk(nextArgs, nextArgs.tw.nextNode());

    walk(args, args.tw.nextSibling());
  },

  use: (args: WalkerArgs) => {
    const { root, tw, scene } = args;
    const useEl = tw.currentNode as Element;

    const id = useEl.getAttribute("href") || useEl.getAttribute("xlink:href");

    if (!id) {
      throw new Error("unable to get id of use element");
    }

    const defEl = root.querySelector(id);

    if (!defEl) {
      throw new Error(`unable to find def element with id: ${id}`);
    }

    const tempScene = new ExcalidrawScene();

    const finalEl = getDefElWithCorrectAttrs(defEl, useEl);

    walk(
      {
        ...args,
        scene: tempScene,
        tw: createTreeWalker(finalEl),
      },
      finalEl,
    );

    const exEl = tempScene.elements.pop();

    if (!exEl) {
      throw new Error("Unable to create ex element");
    }

    scene.elements.push(exEl);

    walk(args, args.tw.nextNode());
  },

  circle: (args: WalkerArgs): void => {
    const { tw, scene, groups } = args;
    const el = tw.currentNode as Element;

    const r = getNum(el, "r", 0);
    const d = r * 2;
    const x = getNum(el, "x", 0) + getNum(el, "cx", 0) - r;
    const y = getNum(el, "y", 0) + getNum(el, "cy", 0) - r;

    const mat = getTransformMatrix(el, groups);

    // @ts-ignore
    const m = mat4.fromValues(d, 0, 0, 0, 0, d, 0, 0, 0, 0, 1, 0, x, y, 0, 1);

    const result = mat4.multiply(mat4.create(), mat, m);

    const circle: ExcalidrawEllipse = {
      ...createExEllipse(),
      ...presAttrs(el, groups),
      x: result[12],
      y: result[13],
      width: result[0],
      height: result[5],
      groupIds: groups.map((g) => g.id),
    };

    scene.elements.push(circle);

    walk(args, tw.nextNode());
  },

  ellipse: (args: WalkerArgs): void => {
    const { tw, scene, groups } = args;
    const el = tw.currentNode as Element;

    const rx = getNum(el, "rx", 0);
    const ry = getNum(el, "ry", 0);
    const cx = getNum(el, "cx", 0);
    const cy = getNum(el, "cy", 0);
    const x = getNum(el, "x", 0) + cx - rx;
    const y = getNum(el, "y", 0) + cy - ry;
    const w = rx * 2;
    const h = ry * 2;

    const mat = getTransformMatrix(el, groups);

    const m = mat4.fromValues(w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, x, y, 0, 1);

    const result = mat4.multiply(mat4.create(), mat, m);

    const ellipse: ExcalidrawEllipse = {
      ...createExEllipse(),
      ...presAttrs(el, groups),
      x: result[12],
      y: result[13],
      width: result[0],
      height: result[5],
      groupIds: groups.map((g) => g.id),
    };

    scene.elements.push(ellipse);

    walk(args, tw.nextNode());
  },

  line: (args: WalkerArgs) => {
    // unimplemented
    walk(args, args.tw.nextNode());
  },

  polygon: (args: WalkerArgs) => {
    const { tw, scene, groups } = args;
    const el = tw.currentNode as Element;

    const points = pointsAttrToPoints(el);

    const mat = getTransformMatrix(el, groups);

    const transformedPoints = transformPoints(points, mat);

    // The first point needs to be 0, 0, and all following points
    // are relative to the first point.
    const x = transformedPoints[0][0];
    const y = transformedPoints[0][1];

    const relativePoints = transformedPoints.map(([_x, _y]) => [
      _x - x,
      _y - y,
    ]);

    const [width, height] = dimensionsFromPoints(relativePoints);

    const line: ExcalidrawLine = {
      ...createExLine(),
      ...getGroupAttrs(groups),
      ...presAttrsToElementValues(el),
      points: relativePoints.concat([[0, 0]]),
      x,
      y,
      width,
      height,
    };

    scene.elements.push(line);

    walk(args, args.tw.nextNode());
  },

  polyline: (args: WalkerArgs) => {
    const { tw, scene, groups } = args;
    const el = tw.currentNode as Element;

    const mat = getTransformMatrix(el, groups);

    const points = pointsAttrToPoints(el);
    const transformedPoints = transformPoints(points, mat);

    // The first point needs to be 0, 0, and all following points
    // are relative to the first point.
    const x = transformedPoints[0][0];
    const y = transformedPoints[0][1];

    const relativePoints = transformedPoints.map(([_x, _y]) => [
      _x - x,
      _y - y,
    ]);

    const [width, height] = dimensionsFromPoints(relativePoints);

    const hasFill = has(el, "fill");
    const fill = get(el, "fill");

    const shouldFill = !hasFill || (hasFill && fill !== "none");

    const line: ExcalidrawLine = {
      ...createExLine(),
      ...getGroupAttrs(groups),
      ...presAttrsToElementValues(el),
      points: relativePoints.concat(shouldFill ? [[0, 0]] : []),
      x,
      y,
      width,
      height,
    };

    scene.elements.push(line);

    walk(args, args.tw.nextNode());
  },

  text: (args: WalkerArgs) => {
    const { tw, scene, groups, root } = args;
    const el = tw.currentNode as Element;

    // Adjust height reflects the fact that the text is drawn from the bottom
    // and so needs to be adjusted by fontSize to line up with expectation.
    // When this SVG is parsed from Excalidraw, this adjustment has already
    // been assumed to take place.
    const adjustHeight = !root.documentElement.innerHTML.includes("excalidraw");

    // Create initial variables to be set by class, style, or default
    let fontSize = 10;

    // Set values via class
    const styleElm = root.querySelector("style");
    const styleRules = styleElm?.sheet?.cssRules;
    const className = el.getAttribute("class");
    if (className && styleRules) {
      const rule = Array.from(styleRules).find(
        (r) =>
          (r as CSSStyleRule).selectorText === `.${className}` ||
          (r as CSSStyleRule).selectorText === `.${className} tspan` ||
          (r as CSSStyleRule).selectorText === `text.${className}` ||
          (r as CSSStyleRule).selectorText === `text.${className} tspan`,
      );

      fontSize = rule
        ? parseFloat((rule as CSSStyleRule).style.fontSize)
        : fontSize;
    }

    fontSize = getNum(el, "font-size", fontSize);
    const x = getNum(el, "x", 0);
    const y = getNum(el, "y", 0);
    const hasFill = has(el, "fill");
    const fill = get(el, "fill");
    const mat = getTransformMatrix(el, groups);
    const m = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1);
    const result = mat4.multiply(mat4.create(), mat, m);

    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      // If TEXT_NODE, create a text element.
      if (child.nodeType === Node.TEXT_NODE) {
        const textContent = child.textContent || "";

        const text: ExcalidrawText = {
          ...createExText(),
          ...presAttrs(el, groups),
          x: result[12],
          y: adjustHeight ? result[13] - (fontSize || 10) : result[13],
          originalText: textContent,
          fillStyle: "hachure",
          text: textContent,
          strokeColor: hasFill ? fill : "#1E1E1E",
          backgroundColor: "transparent",
          width: 8 * textContent.length,
          lineHeight: 1.5,
          height: 15,
          fontSize: fontSize || 10,
          fontFamily: 2,
        };

        scene.elements.push(text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as Element;
        // If tspan (ELEMENT_NODE), create a text element for each tspan
        if (childEl.tagName === "tspan") {
          const textContent = childEl.textContent || "";

          // Inherit from parent if not set on child
          const childFontSize = has(childEl, "font-size")
            ? getNum(childEl, "font-size", 10)
            : fontSize;
          const hasChildFill = has(childEl, "fill");
          const childFill = has(childEl, "fill") ? get(childEl, "fill") : fill;
          const childX = has(childEl, "x") ? getNum(childEl, "x", 0) : x;
          const childY = has(childEl, "y") ? getNum(childEl, "y", 0) : y;

          const updatedM = mat4.fromValues(
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            childX,
            childY,
            0,
            1,
          );
          const updatedResult = mat4.multiply(mat4.create(), mat, updatedM);

          const text: ExcalidrawText = {
            ...createExText(),
            ...presAttrs(el, groups),
            x: updatedResult[12],
            y: adjustHeight
              ? updatedResult[13] - (fontSize || 10)
              : updatedResult[13],
            originalText: textContent,
            fillStyle: "hachure",
            text: textContent,
            strokeColor: hasFill || hasChildFill ? childFill : "#1E1E1E",
            backgroundColor: "transparent",
            width: 8 * textContent.length,
            lineHeight: 1.5,
            height: 15,
            fontSize: childFontSize || 10,
            fontFamily: 2,
          };

          scene.elements.push(text);
        }
      }
    }

    walk(args, args.tw.nextNode());
  },

  rect: (args: WalkerArgs) => {
    const { tw, scene, groups } = args;
    const el = tw.currentNode as Element;

    const x = getNum(el, "x", 0);
    const y = getNum(el, "y", 0);
    const w = getNum(el, "width", 0);
    const h = getNum(el, "height", 0);

    const mat = getTransformMatrix(el, groups);

    // @ts-ignore
    const m = mat4.fromValues(w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, x, y, 0, 1);

    const result = mat4.multiply(mat4.create(), mat, m);

    /*
    NOTE: Currently there doesn't seem to be a way to specify the border
          radius of a rect within Excalidraw. This means that attributes
          rx and ry can't be used.
    */
    const isRound = el.hasAttribute("rx") || el.hasAttribute("ry");

    const rect: ExcalidrawRectangle = {
      ...createExRect(),
      ...presAttrs(el, groups),
      x: result[12],
      y: result[13],
      width: result[0],
      height: result[5],
      strokeSharpness: isRound ? "round" : "sharp",
    };

    scene.elements.push(rect);

    walk(args, args.tw.nextNode());
  },

  path: (args: WalkerArgs) => {
    const { tw, scene, groups } = args;
    const el = tw.currentNode as Element;

    const mat = getTransformMatrix(el, groups);

    const points = pointsOnPath(get(el, "d"));

    const fillColor = get(el, "fill", "transparent");
    const fillRule = get(el, "fill-rule", "nonzero");

    let elements: ExcalidrawDraw[] = [];
    let localGroup = randomId();

    switch (fillRule) {
      case "nonzero":
        let initialWindingOrder = "clockwise";

        elements = points.map((pointArr, idx): ExcalidrawDraw => {
          const tPoints: Point[] = transformPoints(pointArr, mat4.clone(mat));
          const x = tPoints[0][0];
          const y = tPoints[0][1];

          const [width, height] = dimensionsFromPoints(tPoints);

          const relativePoints = tPoints.map(
            ([_x, _y]): Point => [_x - x, _y - y],
          );

          const windingOrder = getWindingOrder(relativePoints);
          if (idx === 0) {
            initialWindingOrder = windingOrder;
            localGroup = randomId();
          }

          let backgroundColor = fillColor;
          if (backgroundColor === "none") {
            backgroundColor = "transparent";
          }
          if (initialWindingOrder !== windingOrder) {
            backgroundColor = "#FFFFFF";
          }

          return {
            ...createExDraw(),
            strokeWidth: 0,
            strokeColor: "#00000000",
            ...presAttrs(el, groups),
            points: relativePoints,
            backgroundColor,
            width,
            height,
            x: x + getNum(el, "x", 0),
            y: y + getNum(el, "y", 0),
            groupIds: [localGroup],
          };
        });
        break;
      case "evenodd":
        elements = points.map((pointArr, idx): ExcalidrawDraw => {
          const tPoints: Point[] = transformPoints(pointArr, mat4.clone(mat));
          const x = tPoints[0][0];
          const y = tPoints[0][1];

          const [width, height] = dimensionsFromPoints(tPoints);

          const relativePoints = tPoints.map(
            ([_x, _y]): Point => [_x - x, _y - y],
          );

          if (idx === 0) {
            localGroup = randomId();
          }

          return {
            ...createExDraw(),
            ...presAttrs(el, groups),
            points: relativePoints,
            width,
            height,
            x: x + getNum(el, "x", 0),
            y: y + getNum(el, "y", 0),
          };
        });
        break;
      default:
    }

    scene.elements = scene.elements.concat(elements);

    walk(args, tw.nextNode());
  },
};

export function walk(args: WalkerArgs, nextNode: Node | null): void {
  if (!nextNode) {
    return;
  }

  const nodeName = nextNode.nodeName as keyof typeof walkers;
  if (walkers[nodeName]) {
    walkers[nodeName](args);
  }
}
